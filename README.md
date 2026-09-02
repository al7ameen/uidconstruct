# uidconstruct v2.2

Turn any website URL into a buildable UI specification — colors, typography, spacing, layout, responsive rules — ready for your AI editor.

## 📁 Project Structure

```
uidconstruct/
├── index.html          # Main landing page
├── style.css           # All styles (light + dark themes)
├── app.js              # Frontend logic
├── package.json        # Backend dependencies
├── .env.example        # API key template
├── README.md           # This file
└── api/
    └── deconstruct.js  # Backend API endpoint
```

## 🚀 Quick Start (Frontend Only)

Just open `index.html` in a browser. It works out of the box with a sample prompt. No backend needed.

```bash
# On your phone
# 1. Copy this folder to your phone's storage (e.g. /storage/emulated/0/uidconstruct)
# 2. Open index.html in any browser
```

## 🔧 Full Setup (with Backend)

### Step 1: Install Node.js

Download from [nodejs.org](https://nodejs.org) (LTS version recommended).

### Step 2: Install Dependencies

```bash
cd uidconstruct
npm install
```

### Step 3: Add Your API Key

```bash
# Copy the template
cp .env.example .env

# Edit .env and paste your custom API key
UID_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxx
UID_PROVIDER=openai  # or 'anthropic' or 'html-extract' (no key)
```

### Step 4: Start the Server

```bash
npm start
```

Server runs at `http://localhost:3000`.

### Step 5: Open the Frontend

Open `index.html` in a browser, or serve it:

```bash
# Option A: Python
python3 -m http.server 8080

# Option B: Node
npx serve .
```

Visit `http://localhost:8080`.

## 🔑 Supported API Providers

### Option 1: HTML Extract (no key, default)
Extracts colors, fonts, and styles directly from the page HTML. Free, instant, no key needed.

### Option 2: OpenAI
```env
UID_PROVIDER=openai
UID_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxx
UID_MODEL=gpt-4o-mini
```

### Option 3: Anthropic Claude
```env
UID_PROVIDER=anthropic
UID_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxx
```

## 📱 Deploy to Your Phone

After running the project, you can:

1. **Manual copy**: Copy the entire `uidconstruct` folder to your phone using a USB cable, or via cloud storage (Google Drive, Dropbox).
2. **GitHub Pages**: Push to GitHub, enable Pages in repo settings.
3. **Vercel/Netlify**: One-click deploy from the dashboard.

## 🎨 Customization

- **Colors**: Edit the `:root` and `[data-theme="dark"]` blocks in `style.css`
- **Fonts**: Change the Google Fonts link in `index.html`
- **Daily limit**: Change `DAILY_LIMIT` in `app.js`
- **Pricing**: Edit the pricing section in `index.html`

## 🐛 Troubleshooting

**Q: The page shows a sample prompt instead of analyzing URLs**
A: You're viewing `index.html` directly. Either start the backend (`npm start`) or use a static server.

**Q: API returns 504 timeout**
A: The target website is too slow or blocking requests. Try a different URL.

**Q: Daily limit reached**
A: Free tier is 1 site/day. Change `DAILY_LIMIT` in `app.js` for testing, or upgrade to Pro.

## 📜 License

MIT — do whatever you want.

---

Built with care. Made in India 🇮🇳
