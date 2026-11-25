// Note: This file contains the backend logic usually deployed to Firebase Cloud Functions.
// In this web-only environment, we have commented this out to prevent browser runtime errors 
// caused by 'firebase-admin' trying to access Node.js built-ins.
// The logic is effectively simulated in the client-side code for this demo.

/*
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';

admin.initializeApp();
const db = admin.firestore();

// API Key must be obtained exclusively from process.env.API_KEY
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const processGuestMessage = onDocumentCreated(
  'hotels/{hotelId}/sessions/{sessionId}/messages/{messageId}',
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const message = snap.data();
    const { hotelId, sessionId } = event.params;

    // 1. Only process guest messages
    if (message.sender !== 'guest') return;

    // 2. Retrieve Conversation History
    const historySnap = await db.collection(`hotels/${hotelId}/sessions/${sessionId}/messages`)
      .orderBy('timestamp', 'asc')
      .get();
    
    const history = historySnap.docs.map(doc => ({
      text: doc.data().text,
      sender: doc.data().sender
    }));

    // 3. Retrieve Hotel Config
    const hotelDoc = await db.doc(`hotels/${hotelId}`).get();
    const hotelConfig = hotelDoc.data();

    // 4. Call Gemini
    const model = 'gemini-2.5-flash';
    const contents = history.map(msg => ({
        role: msg.sender === 'guest' ? 'user' : 'model',
        parts: [{ text: msg.text }]
    }));

    try {
        const result = await ai.models.generateContent({
            model,
            contents,
            config: {
                systemInstruction: `You are Ren. Hotel: ${hotelConfig?.name}.`,
                // ... tools config same as frontend ...
            }
        });
        
        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        // 5. Write Response
        if (responseText) {
            await db.collection(`hotels/${hotelId}/sessions/${sessionId}/messages`).add({
                sender: 'ai',
                text: responseText,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sessionId
            });
        }
        
        // 6. Handle Tools (simplified)
        // ... (create request logic)

    } catch (error) {
        console.error("AI Generation Error", error);
    }
  }
);
*/