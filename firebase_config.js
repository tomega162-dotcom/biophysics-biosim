// BioSim Firebase Integration Module
// This script handles the initialization and core database operations

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    increment,
    serverTimestamp,
    query,
    where,
    getDocs,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let db, auth;

// Initialize Firebase
const firebaseConfig = {
    apiKey: "AIzaSyACpdrPCel5qc1wTECoMp8GKQaHYjwb-M4",
    authDomain: "biosim-laboratory.firebaseapp.com",
    projectId: "biosim-laboratory",
    storageBucket: "biosim-laboratory.firebasestorage.app",
    messagingSenderId: "572026392525",
    appId: "1:572026392525:web:eddbca8b3759e8c739be84"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
db = getFirestore(app);
auth = getAuth(app);

/**
 * Validate a student PIN and return the student record or error
 */
export async function validateStudentPin(pin) {
    try {
        // 1. Check if PIN exists in the pool
        const pinRef = doc(db, "accessPins", pin);
        const pinSnap = await getDoc(pinRef);

        if (!pinSnap.exists()) {
            throw new Error("INVALID_PIN");
        }

        const pinData = pinSnap.data();

        // 2. Check if PIN is already assigned to another student
        if (pinData.used && pinData.assignedTo) {
            const userRef = doc(db, "users", pinData.assignedTo);
            const userSnap = await getDoc(userRef);
            
            // Safety Check: If user record is missing (migration/schema change), allow re-registration
            if (!userSnap.exists()) {
                return { status: "NEW", data: pinData };
            }

            const userData = userSnap.data();
            return {
                status: "RETURNING",
                studentId: pinData.assignedTo,
                trialsUsed: userData.trialsUsed || 0,
                studentData: userData
            };
        }

        return { status: "NEW", data: pinData };
    } catch (error) {
        console.error("Auth Error:", error);
        throw error;
    }
}

/**
 * Activate a new student PIN
 */
export async function activateStudent(pin, studentData) {
    try {
        const studentUid = auth.currentUser ? auth.currentUser.uid : `std_${Date.now()}`;

        await runTransaction(db, async (transaction) => {
            const pinRef = doc(db, "accessPins", pin);
            const userRef = doc(db, "users", studentUid);

            const pinSnap = await transaction.get(pinRef);
            if (!pinSnap.exists()) throw new Error("INVALID_PIN");
            if (pinSnap.data().used) throw new Error("PIN_ALREADY_USED");

            // 1. Mark PIN as used
            transaction.update(pinRef, {
                used: true,
                assignedTo: studentUid,
                activatedAt: serverTimestamp()
            });

            // 2. Create User Document (New Schema)
            transaction.set(userRef, {
                studentName: studentData.studentName || "",
                studentId: studentData.studentId || "",
                email: studentData.email || "",
                pinCode: pin,
                role: "student",
                university: studentData.university || "",
                faculty: studentData.faculty || "",
                department: studentData.department || "",
                course: studentData.course || "",
                courseCode: studentData.courseCode || "",
                group: studentData.group || "",
                yearOfStudy: studentData.yearOfStudy || "",
                
                // Location Data
                country: studentData.country || "",
                city: studentData.city || "",
                campus: studentData.campus || "",
                building: studentData.building || "",
                labRoom: studentData.labRoom || "",
                deviceLocation: studentData.deviceLocation || "",
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                ipAddress: studentData.ipAddress || "",
                coordinates: studentData.coordinates || null,

                accessGranted: true,
                trialLimit: 10,
                trialsUsed: 0,
                trialsRemaining: 10,
                totalScore: 0,
                bestTotalScore: 0,
                averageTotalScore: 0,
                completedCases: [],
                lastSessionId: null,
                lastSessionDate: null,
                lastSessionGrade: null,
                lastSessionPercent: null,
                firstLogin: serverTimestamp(),
                lastLogin: serverTimestamp()
            });
        });

        return { uid: studentUid };
    } catch (error) {
        console.error("Activation Error:", error);
        throw error;
    }
}

/**
 * Log a simulation attempt and increment trial counter
 */
export async function logSimulationAttempt(studentUid, attemptData) {
    const userRef = doc(db, "users", studentUid);
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
        await runTransaction(db, async (transaction) => {
            const userSnap = await transaction.get(userRef);
            if (!userSnap.exists()) throw new Error("USER_NOT_FOUND");
            const data = userSnap.data();

            if (data.trialsUsed >= data.trialLimit) {
                throw new Error("LIMIT_EXCEEDED");
            }

            // Update user record
            transaction.update(userRef, {
                trialsUsed: increment(1),
                trialsRemaining: increment(-1),
                lastLogin: serverTimestamp(),
                lastSessionId: sessionId
            });

            // Create Session sub-collection entry
            const sessionRef = doc(db, "users", studentUid, "sessions", sessionId);
            transaction.set(sessionRef, {
                sessionId,
                timestamp: serverTimestamp(),
                caseIndex: attemptData.caseIndex,
                caseTitle: attemptData.caseTitle,
                
                // Session Location Telemetry
                sessionCountry: data.country || "",
                sessionCity: data.city || "",
                sessionDeviceLocation: data.deviceLocation || "",
                sessionTimezone: data.timezone || "",
                sessionIpAddress: data.ipAddress || "",
                sessionCoordinates: data.coordinates || null,
                
                // Tech Specs
                userAgent: attemptData.userAgent || "",
                screenRes: attemptData.screenRes || "",
                variant: attemptData.variant || "standard",
                
                // Progress
                status: "STARTED",
                score: 0,
                percent: 0,
                grade: "PENDING"
            });
        });
        return sessionId;
    } catch (error) {
        console.error("Log Attempt Error:", error);
        throw error;
    }
}

/**
 * Sync student progress and case scores
 */
export async function syncStudentProgress(studentUid, progressData) {
    if (!progressData.sessionId) return;
    
    const userRef = doc(db, "users", studentUid);
    const sessionRef = doc(db, "users", studentUid, "sessions", progressData.sessionId);
    
    try {
        // Calculate Grade
        const percent = Math.min(100, Math.round(progressData.score));
        let grade = "F";
        if (percent >= 90) grade = "A+";
        else if (percent >= 80) grade = "A";
        else if (percent >= 70) grade = "B";
        else if (percent >= 60) grade = "C";
        else if (percent >= 50) grade = "D";

        // 1. Update Session Document
        await updateDoc(sessionRef, {
            status: progressData.isComplete ? "COMPLETED" : "IN_PROGRESS",
            score: progressData.score,
            percent: percent,
            grade: grade,
            sliderAdjustments: progressData.sliderAdjustments || 0,
            diagnosisRT: progressData.diagnosisRT || 0,
            finalATP: progressData.finalATP || 0,
            finalViability: progressData.finalViability || 0,
            finalMembrane: progressData.finalMembrane || 0,
            completedAt: serverTimestamp()
        });

        // 2. Update User Profile Aggregates
        await updateDoc(userRef, {
            [`progress.case_${progressData.caseIndex}`]: progressData.score,
            completedCases: increment(progressData.isComplete ? 1 : 0),
            totalScore: increment(progressData.score),
            lastSessionDate: serverTimestamp(),
            lastSessionGrade: grade,
            lastSessionPercent: percent,
            lastLogin: serverTimestamp()
        });
    } catch (error) {
        console.error("Progress Sync Error:", error);
    }
}

export { db, auth };
// Cache Buster: Sun May 10 02:45:17 PM EEST 2026
