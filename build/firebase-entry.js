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

import { initializeApp } from "firebase/app";

import {
  initializeAuth,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePassword,
  sendPasswordResetEmail,
  deleteUser,
  signOut,
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
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";

export const app = { initializeApp };

export const auth = {
  initializeAuth,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePassword,
  sendPasswordResetEmail,
  deleteUser,
  signOut,
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
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
};
