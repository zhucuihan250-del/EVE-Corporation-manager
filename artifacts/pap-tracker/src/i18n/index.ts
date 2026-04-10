import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en";
import zh from "./zh";

const savedLang = localStorage.getItem("pap-lang") || "en";

i18n.use(initReactI18next).init({
  resources: { en, zh },
  lng: savedLang,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
