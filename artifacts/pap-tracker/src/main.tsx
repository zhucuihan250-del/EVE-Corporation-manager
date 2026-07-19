import { createRoot } from "react-dom/client";
import "@/lib/api";
import App from "./App";
import "./index.css";
import "./i18n";

createRoot(document.getElementById("root")!).render(<App />);
