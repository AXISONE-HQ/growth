import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCStzvUnQ4Rqa2Mmn9Tg_ZKKoCVdB8-oh4",
  authDomain: "growth-493400.firebaseapp.com",
  projectId: "growth-493400",
  storageBucket: "growth-493400.firebasestorage.app",
  messagingSenderId: "1086551891973",
  appId: "1:1086551891973:web:a64d0ca628747e7c63fc6c"
};

// Initialize Firebase  singleton pattern for Next.js hot reloads
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export { app, auth, googleProvider };
