// BioSim Firebase Integration Module — Clean Schema v4
// Collection: users (flat document with embedded trialsHistory array)
// Each trial contains exactly 7 pre-initialized case slots
// Timestamps: ISO 8601 strings
// Location: Detected via ipapi.co geolocation service

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let db, auth;

// Firebase Project Configuration
const firebaseConfig = {
    apiKey: "AIzaSyDzy5Vxzz-IAukk3tE_9647J78rAgp2IdE",
    authDomain: "biosim-lab-v2.firebaseapp.com",
    projectId: "biosim-lab-v2",
    storageBucket: "biosim-lab-v2.firebasestorage.app",
    messagingSenderId: "341124314812",
    appId: "1:341124314812:web:13d75d9924b143ddaf02b9"
};

const app = initializeApp(firebaseConfig);
db = getFirestore(app);
auth = getAuth(app);

// =====================================================================
// CASE NAMES — used to pre-initialize 7 case slots
// =====================================================================
const CASE_NAMES = [
    "MEMBRANE TRANSPORT",
    "OSMOSIS & TONICITY",
    "ACTIVE TRANSPORT & ENERGY",
    "BIOELECTRICITY & AP",
    "RADIATION & SHIELDING",
    "LIPOSOME DELIVERY",
    "RADIATION & DNA DAMAGE"
];

// Create 7 empty case slots for a new trial
function createEmptyCaseSlots() {
    return CASE_NAMES.map((name, i) => ({
        caseId: i,
        caseName: name,
        startedAt: null,
        exitTime: null,
        duration: 0,
        optimalTime: 0,
        stabilityScore: 0,
        actionsTaken: 0,
        efficiencyPenalty: 0,
        totalScore: 0,
        grade: "",
        gradeLabel: "",
        completed: false,
        completedAt: null
    }));
}

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

        return {
            city: data.city || "",
            region: data.region || "",
            country: data.country_name || "",
            countryCode: data.country_code || "",
            postalCode: data.postal || "",
            ipAddress: data.ip || "",
            isp: data.org || "",
            timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
            coordinates: {
                latitude: data.latitude || 0,
                longitude: data.longitude || 0
            }
        };
    } catch (e) {
        console.warn('Geolocation detection failed, using fallback:', e.message);
        return {
            city: "", region: "", country: "", countryCode: "",
            postalCode: "", ipAddress: "", isp: "",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            coordinates: { latitude: 0, longitude: 0 }
        };
    }
}

// =====================================================================
// PIN VALIDATION
// =====================================================================

/**
 * Validate a student PIN and return status + student data.
 * Returns: { status: "NEW" | "RETURNING", studentId?, totalTrials?, studentData? }
 * Throws: "INVALID_PIN", "LIMIT_EXCEEDED"
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

            // Enforce trial limit
            const limit = studentData.trialLimit || 10;
            const used = studentData.trialsUsed || 0;
            if (used >= limit) {
                throw new Error("LIMIT_EXCEEDED");
            }

            return {
                status: "RETURNING",
                studentId: pinData.assignedTo,
                trialsUsed: used,
                trialsRemaining: limit - used,
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
 * Creates profile with all global fields + starts the first trial.
 * Each trial is pre-initialized with 7 empty case slots.
 * Returns { uid, trialId }
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

            // Admin PINs get unlimited trials, students get 10
            const pinRole = pinSnap.data().role || "student";
            const isAdmin = pinRole === "admin";
            const trialLimit = isAdmin ? 9999 : 10;

            // Mark PIN as used
            transaction.update(pinRef, {
                used: true,
                assignedTo: studentUid,
                activatedAt: now
            });

            // First trial with 7 pre-initialized case slots
            const firstTrial = {
                trialId: trialId,
                trialNumber: 1,
                entryTime: now,
                exitTime: null,
                duration: 0,
                completedAt: null,
                overallScore: 0,
                overallPercent: 0,
                overallGrade: "",
                totalCasesCompleted: 0,
                finalOutcome: "IN_PROGRESS",
                casesScores: createEmptyCaseSlots()
            };

            // Build student document — matches existing Firebase field names exactly
            const studentDoc = {
                // Identity
                studentName: studentData.fullName || "",
                studentId: studentData.studentId || "",
                pinCode: pin,
                role: pinRole,
                accessGranted: true,

                // Academic
                university: studentData.university || "",
                faculty: studentData.faculty || "",
                department: studentData.department || "",
                course: studentData.courseName || "",
                courseCode: studentData.courseCode || "",

                // Timestamps
                firstLogin: now,
                lastLogin: now,
                enterTime: now,
                lastSessionDate: now,

                // Location & Device (flattened to match existing structure)
                city: location.city,
                region: location.region,
                country: location.country,
                countryCode: location.countryCode,
                postalCode: location.postalCode,
                ipAddress: location.ipAddress,
                isp: location.isp,
                timezone: location.timezone,
                coordinates: location.coordinates,
                platform: navigator.platform || "",
                userAgent: navigator.userAgent || "",
                language: navigator.language || "",
                screenRes: `${screen.width}x${screen.height}`,

                // Trial tracking
                trialLimit: trialLimit,
                trialsUsed: 1,
                trialsRemaining: trialLimit - 1,

                // Score aggregates (global across all trials)
                totalScore: 0,
                bestTotalScore: 0,
                averageTotalScore: 0,
                completedCases: 0,

                // Last session tracking
                lastSessionId: trialId,
                lastSessionGrade: "",
                lastSessionPercent: 0,

                // Trial data
                trialsHistory: [firstTrial]
            };

            transaction.set(studentRef, studentDoc);
        });

        return { uid: studentUid, trialId: trialId };
    } catch (error) {
        console.error("Activation Error:", error);
        throw error;
    }
}

// =====================================================================
// START NEW SESSION (Returning student — every login/re-entry)
// =====================================================================

/**
 * Creates a new trial for a returning student.
 * Each trial has 7 pre-initialized case slots.
 * Updates trialsUsed/trialsRemaining counters.
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

            const used = (data.trialsUsed || 0) + 1;
            const limit = data.trialLimit || 10;

            if (used > limit) throw new Error("LIMIT_EXCEEDED");

            const newTrial = {
                trialId: trialId,
                trialNumber: used,
                entryTime: now,
                exitTime: null,
                duration: 0,
                completedAt: null,
                overallScore: 0,
                overallPercent: 0,
                overallGrade: "",
                totalCasesCompleted: 0,
                finalOutcome: "IN_PROGRESS",
                casesScores: createEmptyCaseSlots()
            };

            const history = data.trialsHistory || [];
            history.push(newTrial);

            transaction.update(studentRef, {
                trialsHistory: history,
                trialsUsed: used,
                trialsRemaining: Math.max(0, limit - used),
                lastLogin: now,
                lastSessionId: trialId,
                lastSessionDate: now
            });
        });

        return trialId;
    } catch (error) {
        console.error("New Session Error:", error);
        throw error;
    }
}

// =====================================================================
// LOG CASE START (mark a case as started within current trial)
// =====================================================================

/**
 * Updates the pre-initialized case slot with a startedAt timestamp.
 * Does NOT create a new entry — the 7 slots already exist.
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
            const caseIndex = caseData.caseId;

            // Update the pre-initialized slot (direct index access)
            if (caseIndex >= 0 && caseIndex < 7 && trial.casesScores[caseIndex]) {
                trial.casesScores[caseIndex].startedAt = now;
                trial.casesScores[caseIndex].caseName = caseData.caseName || CASE_NAMES[caseIndex];
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
// SYNC CASE COMPLETION (update case scores within current trial)
// =====================================================================

/**
 * Updates a completed case's scores within the current trial.
 * Uses direct array index (0-6) instead of findIndex.
 * Recalculates trial-level aggregates.
 *
 * @param {string} studentUid
 * @param {object} progressData - {
 *   trialId, caseIndex (0-6), caseName,
 *   duration, optimalTime, stabilityScore,
 *   actionsTaken, efficiencyPenalty, totalScore,
 *   grade, gradeLabel, isComplete
 * }
 */
export async function syncStudentProgress(studentUid, progressData) {
    if (!progressData.trialId) return;
    if (progressData.caseIndex < 0 || progressData.caseIndex > 6) return;

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
            const caseIndex = progressData.caseIndex;

            // Preserve startedAt from the original logCaseStart
            const existingStartedAt = trial.casesScores[caseIndex]?.startedAt || now;

            // Update the case slot directly by index
            trial.casesScores[caseIndex] = {
                caseId: caseIndex,
                caseName: progressData.caseName || CASE_NAMES[caseIndex],
                startedAt: existingStartedAt,
                exitTime: progressData.isComplete ? now : null,
                duration: progressData.duration || 0,
                optimalTime: progressData.optimalTime || 0,
                stabilityScore: progressData.stabilityScore || 0,
                actionsTaken: progressData.actionsTaken || 0,
                efficiencyPenalty: progressData.efficiencyPenalty || 0,
                totalScore: progressData.totalScore || 0,
                grade: progressData.grade || "",
                gradeLabel: progressData.gradeLabel || "",
                completed: progressData.isComplete || false,
                completedAt: progressData.isComplete ? now : null
            };

            // Recalculate trial-level aggregates from all 7 case slots
            const completedCases = trial.casesScores.filter(c => c.completed);
            trial.totalCasesCompleted = completedCases.length;
            trial.overallScore = trial.casesScores.reduce((sum, c) => sum + (c.totalScore || 0), 0);
            // Max possible = 7 cases × 140 points = 980
            trial.overallPercent = Math.round((trial.overallScore / 980) * 100);

            // Update trial timing
            const entryMs = new Date(trial.entryTime).getTime();
            trial.duration = Math.round((Date.now() - entryMs) / 1000);

            history[trialIndex] = trial;

            // Recalculate global aggregates from ALL trials
            const allTrialScores = history
                .filter(t => t.totalCasesCompleted > 0)
                .map(t => t.overallScore);
            const bestScore = allTrialScores.length > 0 ? Math.max(...allTrialScores) : 0;
            const avgScore = allTrialScores.length > 0
                ? Math.round(allTrialScores.reduce((a, b) => a + b, 0) / allTrialScores.length)
                : 0;
            const totalCompletedCases = history.reduce((sum, t) => sum + (t.totalCasesCompleted || 0), 0);
            const latestTotalScore = trial.overallScore;

            transaction.update(studentRef, {
                trialsHistory: history,
                completedCases: totalCompletedCases,
                bestTotalScore: bestScore,
                averageTotalScore: avgScore,
                totalScore: latestTotalScore,
                lastLogin: now,
                lastSessionDate: now
            });
        });
    } catch (error) {
        console.error("Progress Sync Error:", error);
    }
}

// =====================================================================
// SYNC TRIAL SUMMARY (called when all 7 cases are done or session ends)
// =====================================================================

/**
 * Updates the trial's final outcome, grade, and overall stats.
 * Also updates global last-session fields.
 *
 * @param {string} studentUid
 * @param {object} summaryData - {
 *   trialId, totalScore, overallGrade, overallPercent, completedCases
 * }
 */
export async function syncTrialSummary(studentUid, summaryData) {
    if (!summaryData.trialId) return;

    const studentRef = doc(db, "users", studentUid);
    const now = new Date().toISOString();

    try {
        await runTransaction(db, async (transaction) => {
            const studentSnap = await transaction.get(studentRef);
            if (!studentSnap.exists()) return;
            const data = studentSnap.data();

            const history = data.trialsHistory || [];
            const trialIndex = history.findIndex(t => t.trialId === summaryData.trialId);
            if (trialIndex === -1) return;

            const trial = history[trialIndex];

            // Update trial-level summary
            trial.exitTime = now;
            trial.completedAt = now;
            trial.overallScore = summaryData.totalScore || trial.overallScore;
            trial.overallPercent = summaryData.overallPercent || trial.overallPercent;
            trial.overallGrade = summaryData.overallGrade || "";
            trial.totalCasesCompleted = summaryData.completedCases || trial.totalCasesCompleted;
            trial.finalOutcome = summaryData.overallGrade || "COMPLETED";

            // Update trial timing
            const entryMs = new Date(trial.entryTime).getTime();
            trial.duration = Math.round((Date.now() - entryMs) / 1000);

            history[trialIndex] = trial;

            // Recalculate global aggregates from ALL trials
            const allTrialScores = history
                .filter(t => t.totalCasesCompleted > 0)
                .map(t => t.overallScore);
            const bestScore = allTrialScores.length > 0 ? Math.max(...allTrialScores) : 0;
            const avgScore = allTrialScores.length > 0
                ? Math.round(allTrialScores.reduce((a, b) => a + b, 0) / allTrialScores.length)
                : 0;
            const totalCompletedCases = history.reduce((sum, t) => sum + (t.totalCasesCompleted || 0), 0);

            transaction.update(studentRef, {
                trialsHistory: history,
                completedCases: totalCompletedCases,
                bestTotalScore: bestScore,
                averageTotalScore: avgScore,
                totalScore: summaryData.totalScore || trial.overallScore,
                lastLogin: now,
                lastSessionId: summaryData.trialId,
                lastSessionDate: now,
                lastSessionGrade: summaryData.overallGrade || "",
                lastSessionPercent: summaryData.overallPercent || 0
            });
        });
    } catch (error) {
        console.error("Trial Summary Sync Error:", error);
    }
}

export { db, auth };
