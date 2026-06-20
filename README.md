# Collab MD Editor

Przeglądarkowy edytor Markdown z kolaboracją w czasie rzeczywistym. Wiele osób może jednocześnie edytować pliki `.md`, widząc kursory i zaznaczenia innych uczestników na żywo.

---

## Funkcjonalności

- **Konta użytkowników** — rejestracja i logowanie z hasłem (bcrypt + SQLite); alternatywnie wejście jako gość bez rejestracji
- **Persystencja sesji** — zalogowany użytkownik pozostaje zalogowany po odświeżeniu strony (token w `localStorage`)
- **Kolaboracja w czasie rzeczywistym** — równoległe edytowanie z widocznymi kursorami i zaznaczeniami innych użytkowników (Yjs CRDT + WebSocket)
- **Pasek narzędzi** — pogrubienie, kursywa, przekreślenie, nagłówki H1–H3, listy, cytaty, linki, bloki kodu; skróty Ctrl+B / Ctrl+I
- **Wybór koloru kursora** — paleta 12 kolorów dostępna przez ikonę ⚙ w nagłówku; wybór zapisywany w `localStorage`
- **Podgląd Markdown** — renderowanie na żywo w panelu obok edytora
- **Zarządzanie plikami** — tworzenie i usuwanie plików `.md` przez interfejs
- **Rate limiting** — max 5 prób logowania / rejestracji na 15 minut per IP
- **Walidacja danych** — reguły sprawdzane po obu stronach (frontend dla UX, backend jako warstwa bezpieczeństwa)
- **Autozapis** — debounced zapis po każdej zmianie (300 ms)

---

## Stos technologiczny

| Warstwa | Technologia |
|---------|-------------|
| Edytor | [CodeMirror 6](https://codemirror.net/) |
| Kolaboracja | [Yjs](https://yjs.dev/) + [y-codemirror.next](https://github.com/yjs/y-codemirror.next) |
| Transport WebSocket | [y-websocket](https://github.com/yjs/y-websocket) |
| Podgląd MD | [marked](https://marked.js.org/) |
| Build frontendu | [Vite](https://vitejs.dev/) |
| Serwer HTTP | [Express](https://expressjs.com/) |
| Baza danych | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Hasła | [bcryptjs](https://github.com/dcodeIO/bcrypt.js) |
| Rate limiting | [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) |

---

## Struktura projektu

```
.
├── server.js          # Serwer Node.js (Express + WebSocket + auth + persystencja)
├── index.html         # Szkielet HTML
├── src/
│   ├── main.js        # Frontend (auth, edytor, toolbar, kolor kursora)
│   └── style.css      # Style
├── files/             # Pliki .md użytkowników (tworzony automatycznie)
├── users.db           # Baza SQLite (tworzona automatycznie)
├── railway.toml       # Konfiguracja Railway
├── .nvmrc             # Wersja Node.js dla Nixpacks / nvm
└── package.json
```

---

## Uruchamianie lokalnie

### Wymagania

- Node.js ≥ 20
- npm ≥ 9

### Instalacja i start

```bash
npm install
npm run dev
```

Uruchamia równocześnie serwer Node.js na `:3000` i Vite dev server na `:5173`.  
Otwórz **`http://localhost:5173`** w przeglądarce.

### Pozostałe skrypty

| Skrypt | Opis |
|--------|------|
| `npm run dev` | Serwer + Vite hot-reload |
| `npm run build` | Build produkcyjny frontendu → `dist/` |
| `npm start` | Tryb produkcyjny (wymaga wcześniejszego `build`) |
| `npm run kill` | Ubija wszystkie procesy `node.exe` |
| `npm run restart` | `kill` + świeży `dev` |

---


---

## API

### Auth

| Metoda | Ścieżka | Opis |
|--------|---------|------|
| `POST` | `/api/auth/register` | Rejestracja. Body: `{ username, password }` → `{ token, username }` |
| `POST` | `/api/auth/login` | Logowanie. Body: `{ username, password }` → `{ token, username }` |
| `GET` | `/api/auth/me` | Weryfikacja tokenu. Header: `Authorization: Bearer <token>` → `{ username }` |
| `POST` | `/api/auth/logout` | Unieważnienie tokenu. Header: `Authorization: Bearer <token>` |

Endpointy `/register` i `/login` są objęte rate limitingiem: **5 prób / 15 minut / IP**.

### Pliki

| Metoda | Ścieżka | Opis |
|--------|---------|------|
| `GET` | `/api/files` | Lista plików `.md` |
| `POST` | `/api/files` | Utwórz plik. Body: `{ name }` |
| `DELETE` | `/api/files/:name` | Usuń plik |

### WebSocket

Klient łączy się pod `wss://<host>/<nazwa-pliku.md>` (produkcja) lub `ws://localhost:3000/<nazwa>` (dev).  
Protokół: standardowa synchronizacja Yjs (binarny, przez `y-websocket`).
