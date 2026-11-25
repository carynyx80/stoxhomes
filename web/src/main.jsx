import "./polyfills.js";
import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fraunces/latin-300.css";
import "@fontsource/fraunces/latin-400.css";
import "@fontsource/fraunces/latin-300-italic.css";
import "@fontsource/fraunces/latin-400-italic.css";
import "@fontsource/inter-tight/latin-400.css";
import "@fontsource/inter-tight/latin-500.css";
import "@fontsource/inter-tight/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);
