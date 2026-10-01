/* The Firebase functions The Scorecard uses — and nothing else.
 *
 * Built by `npm run bundle` (esbuild) into vendor/firebase/firebase-10.12.0.js,
 * which is committed, because GitHub Pages has no build step. Both the web app
 * and the iPhone app load that one file (spec Change 3, D3).
 *
 * Auth comes from firebase/auth/web-extension: Firebase's official build with
 * no remotely hosted code (Apple rule 2.5.2). It supports anonymous and
 * email-and-password sign-in; it has no Google pop-up, which the app no longer
 * uses (Change 4).
 *
 * build/verify.sh (V6) checks that every name store.js takes from
 * fb.mod.auth or fb.mod.store is listed here. */

import { initializeApp, deleteApp } from "firebase/app";

import {
  initializeAuth,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  deleteUser,
  signOut,
  connectAuthEmulator,
} from "firebase/auth/web-extension";

import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  doc,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  getDoc,
  getDocs,
  getDocFromServer,
  getDocsFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  connectFirestoreEmulator,
} from "firebase/firestore";

export const app = { initializeApp, deleteApp };

export const auth = {
  initializeAuth,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  deleteUser,
  signOut,
  connectAuthEmulator,
};

export const store = {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  doc,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  getDoc,
  getDocs,
  getDocFromServer,
  getDocsFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  connectFirestoreEmulator,
};
