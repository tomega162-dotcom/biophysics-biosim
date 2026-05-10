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
            const studentRef = doc(db, "students", pinData.assignedTo);
            const studentSnap = await getDoc(studentRef);
            const studentData = studentSnap.data();

            return {
                status: "RETURNING",
                studentId: pinData.assignedTo,
                trialsUsed: studentData.trialsUsed || 0,
                studentData: studentData
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
            const studentRef = doc(db, "students", studentUid);

            const pinSnap = await transaction.get(pinRef);
            if (pinSnap.data().used) throw new Error("PIN_ALREADY_USED");

            // 1. Mark PIN as used
            transaction.update(pinRef, {
                used: true,
                assignedTo: studentUid,
                activatedAt: serverTimestamp()
            });

            // 2. Create Student Document
            transaction.set(studentRef, {
                ...studentData,
                pinCode: pin,
                role: "student",
                accessGranted: true,
                trialsUsed: 0,
                trialsRemaining: 10,
                trialLimit: 10,
                totalScore: 0,
                firstLogin: serverTimestamp(),
                lastLogin: serverTimestamp(),
                completedCases: []
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
    const studentRef = doc(db, "students", studentUid);

    try {
        await runTransaction(db, async (transaction) => {
            const studentSnap = await transaction.get(studentRef);
            const data = studentSnap.data();

            if (data.trialsUsed >= data.trialLimit) {
                throw new Error("LIMIT_EXCEEDED");
            }

            // Update student record
            transaction.update(studentRef, {
                trialsUsed: increment(1),
                trialsRemaining: increment(-1),
                lastLogin: serverTimestamp()
            });

            // Create log entry
            const logRef = doc(collection(db, "simulationAttempts"));
            transaction.set(logRef, {
                studentUid,
                studentName: data.studentName,
                timestamp: serverTimestamp(),
                ...attemptData
            });
        });
    } catch (error) {
        console.error("Log Attempt Error:", error);
        throw error;
    }
}

/**
 * Sync student progress and case scores
 */
export async function syncStudentProgress(studentUid, progressData) {
    const studentRef = doc(db, "students", studentUid);
    try {
        await updateDoc(studentRef, {
            [`progress.case_${progressData.caseIndex}`]: progressData.score,
            completedCases: increment(progressData.isComplete ? 1 : 0),
            totalScore: increment(progressData.score),
            lastLogin: serverTimestamp()
        });
    } catch (error) {
        console.error("Progress Sync Error:", error);
    }
}

export { db, auth };
// Cache Buster: Sun May 10 02:45:17 PM EEST 2026
