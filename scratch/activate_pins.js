
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyACpdrPCel5qc1wTECoMp8GKQaHYjwb-M4",
    authDomain: "biosim-laboratory.firebaseapp.com",
    projectId: "biosim-laboratory",
    storageBucket: "biosim-laboratory.firebasestorage.app",
    messagingSenderId: "572026392525",
    appId: "1:572026392525:web:eddbca8b3759e8c739be84"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function activatePins() {
    console.log("Starting PIN Activation...");
    const masterPin = "B#8&zP9!kL2$";
    const studentPins = ["P9pv&SvfBe29"];
    
    for(let i=0; i<10; i++) studentPins.push("TEST-" + Math.random().toString(36).substring(7).toUpperCase());

    const batch = writeBatch(db);
    const now = new Date().toISOString();
    
    // 1. Add Master PIN
    const masterRef = doc(db, "accessPins", masterPin);
    batch.set(masterRef, {
        pinCode: masterPin,
        used: false,
        assignedTo: null,
        role: "admin",
        createdAt: now
    });

    // 2. Add Student PINs
    studentPins.forEach(pin => {
        const pinRef = doc(db, "accessPins", pin);
        batch.set(pinRef, {
            pinCode: pin,
            used: false,
            assignedTo: null,
            role: "student",
            createdAt: now
        });
    });

    await batch.commit();
    console.log("✅ SUCCESS: 12 PINs Activated (Master + 11 Students)");
}

activatePins().catch(console.error);
