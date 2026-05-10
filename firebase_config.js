// BioSim Firebase Integration Module - Advanced High-Fidelity Edition
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

// LIVE Firebase Configuration (Retrieved from Console)
const firebaseConfig = {
  "apiKey": "AIzaSyACpdrPCeL5qC1wTEcoMp8GKQaHYjwb-M4",
  "authDomain": "biosim-laboratory.firebaseapp.com",
  "projectId": "biosim-laboratory",
  "storageBucket": "biosim-laboratory.firebasestorage.app",
  "messagingSenderId": "572026392525",
  "appId": "1:572026392525:web:eddbca8b3759e8c739be84"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
db = getFirestore(app);
auth = getAuth(app);

/**
 * Captures the student's IP and precise Geolocation
 */
export async function captureSessionContext() {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const context = {
        sessionId: `SESS-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        sessionStart: new Date().toISOString(),
        userAgent: navigator.userAgent,
        deviceType: isMobile ? "Mobile/Tablet" : "Desktop/Workstation",
        platform: navigator.platform,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        language: navigator.language,
        ipAddress: "Unknown",
        latitude: null,
        longitude: null,
        cityName: "Unknown",
        countryName: "Unknown"
    };

    try {
        // 1. Silent IP Lookup
        const ipRes = await fetch('https://ipapi.co/json/');
        const ipData = await ipRes.json();
        context.ipAddress = ipData.ip;
        context.cityName = ipData.city;
        context.countryName = ipData.country_name;
    } catch (e) { console.warn("IP Lookup Failed:", e); }

    try {
        // 2. Precise GPS (Requires Student Permission)
        const pos = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
        });
        context.latitude = pos.coords.latitude;
        context.longitude = pos.coords.longitude;
    } catch (e) { console.warn("GPS Access Denied/Timed out:", e); }

    return context;
}



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
                accountStatus: "active",
                totalAttempts: 0,
                completedCases: 0,
                sessions: []
            });
        });

        return { uid: studentUid };
    } catch (error) {
        console.error("Activation Error:", error);
        throw error;
    }
}

/**
 * Log a high-fidelity simulation attempt
 */
export async function logSimulationAttempt(studentUid, payload) {
    const studentRef = doc(db, "students", studentUid);
    
    try {
        await runTransaction(db, async (transaction) => {
            const studentSnap = await transaction.get(studentRef);
            const data = studentSnap.data();

            if (data.trialsUsed >= data.trialLimit) {
                throw new Error("LIMIT_EXCEEDED");
            }

            // Update student record (Top-level)
            transaction.update(studentRef, {
                trialsUsed: increment(1),
                trialsRemaining: increment(-1),
                totalAttempts: increment(1),
                lastLogin: serverTimestamp()
            });

            // Create high-fidelity log entry in the 'sessions' sub-collection
            const sessionsRef = collection(studentRef, "sessions");
            const sessionDocRef = doc(sessionsRef); 
            transaction.set(sessionDocRef, {
                timestamp: serverTimestamp(),
                ...payload
            });
            
            return sessionDocRef.id;
        });
        
        return result;
    } catch (error) {
        console.error("Log Attempt Error:", error);
        throw error;
    }
}

/**
 * Sync comprehensive student progress and per-case clinical data into the specific session
 */
export async function syncStudentProgress(studentUid, sessionDocId, progressData) {
    const studentRef = doc(db, "students", studentUid);
    const sessionRef = doc(collection(studentRef, "sessions"), sessionDocId);
    
    try {
        // Update both the student's top-level summary and the specific session document
        await Promise.all([
            updateDoc(studentRef, {
                [`cases.case_${progressData.caseIndex}`]: {
                    score: progressData.score,
                    grade: progressData.details.grade,
                    lastUpdated: serverTimestamp()
                },
                totalScore: increment(progressData.score),
                lastLogin: serverTimestamp()
            }),
            updateDoc(sessionRef, {
                ...progressData.details,
                endTime: serverTimestamp()
            })
        ]);
    } catch (error) {
        console.error("Progress Sync Error:", error);
    }
}

export { db, auth };
