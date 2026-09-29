import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        morandi: {
          rose: "#D4B5B0",
          sky: "#A8B5C8",
          sage: "#A8B8A8",
          wheat: "#D4C8A8",
          mauve: "#B8A8B8",
          stone: "#B8B0A8",
          slate: "#8898A8",
          mocha: "#A89890",
        },
        bg: {
          base: "#FAFAF7",
          card: "#FFFFFF",
          subtle: "#F0EFEA",
        },
        text: {
          primary: "#2C2825",
          secondary: "#6B655F",
          muted: "#9A938D",
        },
        border: { DEFAULT: "#E8E5DF" },
      },
      backgroundImage: {
        "morandi-1": "linear-gradient(135deg, #D4B5B0 0%, #B8A8B8 100%)",
        "morandi-2": "linear-gradient(135deg, #A8B5C8 0%, #A8B8A8 100%)",
        "morandi-3": "linear-gradient(135deg, #D4C8A8 0%, #A89890 100%)",
        "morandi-4": "linear-gradient(135deg, #8898A8 0%, #B8B0A8 100%)",
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        lg: "12px",
        md: "8px",
      },
    },
  },
} satisfies Config;
