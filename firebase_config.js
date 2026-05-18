// BioSim Firebase Integration Module — Clean Schema v3
// Collection: users (flat document with embedded trialsHistory array)
// Hierarchy: PIN → Student Profile → Sessions/Trials → Case Data
// Timestamps: ISO 8601 strings
// Location: Detected via ipapi.co geolocation service

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getFirestore,
    doc,
    getDoc,
    updateDoc,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let db, auth;

// Firebase Project Configuration
const firebaseConfig = {
    apiKey: "AIzaSyACpdrPCel5qc1wTECoMp8GKQaHYjwb-M4",
    authDomain: "biosim-laboratory.firebaseapp.com",
    projectId: "biosim-laboratory",
    storageBucket: "biosim-laboratory.firebasestorage.app",
    messagingSenderId: "572026392525",
    appId: "1:572026392525:web:eddbca8b3759e8c739be84"
};

const app = initializeApp(firebaseConfig);
db = getFirestore(app);
auth = getAuth(app);

// =====================================================================
// GEOLOCATION DETECTION (ipapi.co — 1,000 free requests/day)
// =====================================================================

async function detectLocation() {
    try {
        const res = await fetch('https://ipapi.co/json/', {
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) throw new Error('Geolocation API error');
        const data = await res.json();

        const location = {};
        if (data.city) location.city = data.city;
        if (data.country_name) location.country = data.country_name;
        if (data.latitude) location.latitude = data.latitude;
        if (data.longitude) location.longitude = data.longitude;
        if (data.ip) location.ipAddress = data.ip;
        if (data.timezone) location.timezone = data.timezone;
        else location.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        location.deviceInfo = navigator.userAgent || '';

        return location;
    } catch (e) {
        console.warn('Geolocation detection failed, using fallback:', e.message);
        return {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            deviceInfo: navigator.userAgent || ''
        };
    }
}

// =====================================================================
// HELPER: Build object with only non-empty fields
// =====================================================================

function cleanFields(obj) {
    const clean = {};
    for (const [key, val] of Object.entries(obj)) {
        if (val !== undefined && val !== null && val !== '') {
            clean[key] = val;
        }
    }
    return clean;
}

// =====================================================================
// PIN VALIDATION
// =====================================================================

/**
 * Validate a student PIN and return status + student data.
 * Returns: { status: "NEW" | "RETURNING", studentId?, totalTrials?, studentData? }
 */
export async function validateStudentPin(pin) {
    try {
        if (!auth.currentUser) {
            await signInAnonymously(auth);
        }

        const pinRef = doc(db, "accessPins", pin);
        const pinSnap = await getDoc(pinRef);

        if (!pinSnap.exists()) {
            throw new Error("INVALID_PIN");
        }

        const pinData = pinSnap.data();

        // PIN already assigned to a student
        if (pinData.used && pinData.assignedTo) {
            const studentRef = doc(db, "users", pinData.assignedTo);
            const studentSnap = await getDoc(studentRef);

            // If student record missing, allow re-registration
            if (!studentSnap.exists()) {
                return { status: "NEW", data: pinData };
            }

            const studentData = studentSnap.data();
            return {
                status: "RETURNING",
                studentId: pinData.assignedTo,
                totalTrials: studentData.totalTrials || 0,
                studentData: studentData
            };
        }

        return { status: "NEW", data: pinData };
    } catch (error) {
        console.error("PIN Validation Error:", error);
        throw error;
    }
}

// =====================================================================
// STUDENT ACTIVATION (New student — first login)
// =====================================================================

/**
 * Activate a new student account with a PIN.
 * Creates profile + starts the first session/trial automatically.
 * Returns { uid, trialId } so the UI can track the current session.
 */
export async function activateStudent(pin, studentData) {
    try {
        const studentUid = auth.currentUser ? auth.currentUser.uid : `std_${Date.now()}`;
        const now = new Date().toISOString();
        const location = await detectLocation();
        const trialId = `trial_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        await runTransaction(db, async (transaction) => {
            const pinRef = doc(db, "accessPins", pin);
            const studentRef = doc(db, "users", studentUid);

            const pinSnap = await transaction.get(pinRef);
            if (!pinSnap.exists()) throw new Error("INVALID_PIN");
            if (pinSnap.data().used) throw new Error("PIN_ALREADY_USED");

            // Mark PIN as used
            transaction.update(pinRef, {
                used: true,
                assignedTo: studentUid,
                activatedAt: now
            });

            // First session starts immediately on activation
            const firstSession = {
                trialId: trialId,
                trialType: "simulation_session",
                entryTime: now,
                exitTime: null,
                duration: 0,
                completedAt: null,
                overallScore: 0,
                overallPercent: 0,
                totalCasesCompleted: 0,
                finalOutcome: "IN_PROGRESS",
                casesScores: []
            };

            // Build student document — only populated fields
            const studentDoc = cleanFields({
                studentId: studentData.studentId,
                fullName: studentData.fullName,
                university: studentData.university,
                faculty: studentData.faculty,
                department: studentData.department,
                courseName: studentData.courseName,
                courseCode: studentData.courseCode,
                pinCode: pin,
                role: "student",
                firstLogin: now,
                lastLogin: now,
                totalTrials: 1,
                completedCases: 0,
                bestOverallScore: 0,
                averageOverallScore: 0,
                accessGranted: true,
                location: location,
                trialsHistory: [firstSession]
            });

            transaction.set(studentRef, studentDoc);
        });

        return { uid: studentUid, trialId: trialId };
    } catch (error) {
        console.error("Activation Error:", error);
        throw error;
    }
}

// =====================================================================
// START NEW SESSION (Returning student — every login/refresh/re-entry)
// =====================================================================

/**
 * Creates a new session/trial for a returning student.
 * Called every time a student logs in with an existing PIN.
 * Returns the new trialId.
 */
export async function startNewSession(studentUid) {
    const studentRef = doc(db, "users", studentUid);
    const trialId = `trial_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = new Date().toISOString();

    try {
        await runTransaction(db, async (transaction) => {
            const studentSnap = await transaction.get(studentRef);
            if (!studentSnap.exists()) throw new Error("USER_NOT_FOUND");
            const data = studentSnap.data();

            const newSession = {
                trialId: trialId,
                trialType: "simulation_session",
                entryTime: now,
                exitTime: null,
                duration: 0,
                completedAt: null,
                overallScore: 0,
                overallPercent: 0,
                totalCasesCompleted: 0,
                finalOutcome: "IN_PROGRESS",
                casesScores: []
            };

            const history = data.trialsHistory || [];
            history.push(newSession);

            transaction.update(studentRef, {
                trialsHistory: history,
                totalTrials: (data.totalTrials || 0) + 1,
                lastLogin: now
            });
        });

        return trialId;
    } catch (error) {
        console.error("New Session Error:", error);
        throw error;
    }
}

// =====================================================================
// LOG CASE START (add case entry to current session)
// =====================================================================

/**
 * Adds a new case entry to the current session's casesScores array.
 * Called when the student begins a specific case (e.g. Case 1, Case 2).
 * Does NOT create a new trial — the trial was created at login.
 *
 * @param {string} studentUid
 * @param {string} trialId - The current session's trialId
 * @param {object} caseData - { caseId, caseName }
 */
export async function logCaseStart(studentUid, trialId, caseData) {
    const studentRef = doc(db, "users", studentUid);
    const now = new Date().toISOString();

    try {
        await runTransaction(db, async (transaction) => {
            const studentSnap = await transaction.get(studentRef);
            if (!studentSnap.exists()) return;
            const data = studentSnap.data();

            const history = data.trialsHistory || [];
            const trialIndex = history.findIndex(t => t.trialId === trialId);
            if (trialIndex === -1) return;

            const trial = history[trialIndex];

            // Add the new case (avoid duplicates if re-starting same case)
            const existingIdx = trial.casesScores.findIndex(c => c.caseId === caseData.caseId);
            const caseEntry = {
                caseId: caseData.caseId,
                caseName: caseData.caseName || `Case ${caseData.caseId}`,
                startedAt: now,
                duration: 0,
                optimalTime: 0,
                stabilityScore: 0,
                actionsTaken: 0,
                efficiencyPenalty: 0,
                totalScore: 0,
                completed: false
            };

            if (existingIdx !== -1) {
                // Re-starting same case — overwrite
                trial.casesScores[existingIdx] = caseEntry;
            } else {
                trial.casesScores.push(caseEntry);
            }

            history[trialIndex] = trial;

            transaction.update(studentRef, {
                trialsHistory: history
            });
        });
    } catch (error) {
        console.error("Case Start Log Error:", error);
    }
}

// =====================================================================
// SYNC CASE COMPLETION (update case scores + session aggregates)
// =====================================================================

/**
 * Updates a case's final scores within the current session.
 * Recalculates session and profile aggregates.
 *
 * @param {string} studentUid
 * @param {object} progressData - {
 *   trialId, caseIndex, caseName,
 *   duration, optimalTime, stabilityScore,
 *   actionsTaken, efficiencyPenalty, totalScore,
 *   isComplete
 * }
 */
export async function syncStudentProgress(studentUid, progressData) {
    if (!progressData.trialId) return;

    const studentRef = doc(db, "users", studentUid);
    const now = new Date().toISOString();

    try {
        await runTransaction(db, async (transaction) => {
            const studentSnap = await transaction.get(studentRef);
            if (!studentSnap.exists()) return;
            const data = studentSnap.data();

            const history = data.trialsHistory || [];
            const trialIndex = history.findIndex(t => t.trialId === progressData.trialId);
            if (trialIndex === -1) return;

            const trial = history[trialIndex];

            // Update the specific case
            const caseIdx = trial.casesScores.findIndex(c => c.caseId === progressData.caseIndex);
            const caseScore = {
                caseId: progressData.caseIndex,
                caseName: progressData.caseName || `Case ${progressData.caseIndex}`,
                duration: progressData.duration || 0,
                optimalTime: progressData.optimalTime || 0,
                stabilityScore: progressData.stabilityScore || 0,
                actionsTaken: progressData.actionsTaken || 0,
                efficiencyPenalty: progressData.efficiencyPenalty || 0,
                totalScore: progressData.totalScore || 0,
                grade: progressData.grade || '',
                gradeLabel: progressData.gradeLabel || '',
                completed: progressData.isComplete || false,
                completedAt: progressData.isComplete ? now : null
            };

            if (caseIdx !== -1) {
                trial.casesScores[caseIdx] = caseScore;
            } else {
                trial.casesScores.push(caseScore);
            }

            // Recalculate session-level aggregates
            const completedCases = trial.casesScores.filter(c => c.completed);
            trial.totalCasesCompleted = completedCases.length;
            trial.overallScore = trial.casesScores.reduce((sum, c) => sum + (c.totalScore || 0), 0);
            trial.overallPercent = trial.casesScores.length > 0
                ? Math.round(trial.overallScore / trial.casesScores.length)
                : 0;

            // Update session timing
            const entryMs = new Date(trial.entryTime).getTime();
            trial.duration = Math.round((Date.now() - entryMs) / 1000);

            if (progressData.isComplete) {
                trial.exitTime = now;
                trial.completedAt = now;
                // Store the overall grade label if provided (e.g., DISTINCTION, MERIT, PASS)
                trial.finalOutcome = progressData.gradeLabel || "COMPLETED";
                if (progressData.grade) trial.finalGrade = progressData.grade;
            }

            history[trialIndex] = trial;

            // Recalculate profile-level aggregates from ALL sessions
            const allSessionScores = history
                .filter(t => t.totalCasesCompleted > 0)
                .map(t => t.overallScore);
            const bestScore = allSessionScores.length > 0 ? Math.max(...allSessionScores) : 0;
            const avgScore = allSessionScores.length > 0
                ? Math.round(allSessionScores.reduce((a, b) => a + b, 0) / allSessionScores.length)
                : 0;
            const totalCompletedCases = history.reduce((sum, t) => sum + t.totalCasesCompleted, 0);

            transaction.update(studentRef, {
                trialsHistory: history,
                completedCases: totalCompletedCases,
                bestOverallScore: bestScore,
                averageOverallScore: avgScore,
                lastLogin: now
            });
        });
    } catch (error) {
        console.error("Progress Sync Error:", error);
    }
}

export { db, auth };
