
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, setDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
    const studentPins = ["P9pv&SvfBe29"]; // User provided PIN
    
    // Generate some more sample PINs to fill the pool if needed
    for(let i=0; i<10; i++) studentPins.push("TEST-" + Math.random().toString(36).substring(7).toUpperCase());

    const batch = writeBatch(db);
    
    // 1. Add Master PIN
    const masterRef = doc(db, "accessPins", masterPin);
    batch.set(masterRef, {
        pinCode: masterPin,
        used: false,
        role: "admin",
        trialLimit: 100,
        createdAt: serverTimestamp()
    });

    // 2. Add Student PINs
    studentPins.forEach(pin => {
        const pinRef = doc(db, "accessPins", pin);
        batch.set(pinRef, {
            pinCode: pin,
            used: false,
            role: "student",
            trialLimit: 10,
            createdAt: serverTimestamp()
        });
    });

    await batch.commit();
    console.log("✅ SUCCESS: 12 PINs Activated (Master + 11 Students)");
}

activatePins().catch(console.error);
