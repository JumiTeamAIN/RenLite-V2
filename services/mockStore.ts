// This file is deprecated. Please use services/db.ts and services/firebase.ts
// Keeping this file to prevent compile errors if imports haven't fully propagated in cache, 
// but it should not be used.

export const store = {
  // Placeholder to fail loudly if used
  login: () => console.error("Use firebase auth"),
  createSession: () => console.error("Use dbService"),
};