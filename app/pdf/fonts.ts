import path from "node:path";
import { Font } from "@react-pdf/renderer";

// Noto Sans (SIL Open Font License, public/fonts): Latin, Greek and Cyrillic incl. ë, ç, ü (G-3).
// ponytail: no Arabic/CJK glyphs; register Noto Sans Arabic / CJK when a merchant needs them.
let registered = false;

const registerFonts = () => {
  if (registered) return;
  const dir = path.join(process.cwd(), "public", "fonts");
  Font.register({
    family: "Noto Sans",
    fonts: [
      { src: path.join(dir, "NotoSans-Regular.ttf") },
      { src: path.join(dir, "NotoSans-Bold.ttf"), fontWeight: "bold" },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]); // never hyphenate SKUs and names
  registered = true;
};

export { registerFonts };
