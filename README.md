# 📖 Mobi to StarDict Dictionary Converter

🌐 **[Project website & live tools → random90.github.io/mobiDictToStarDictConverter](https://random90.github.io/mobiDictToStarDictConverter)**

## 🇵🇱 Informacja o projekcie [Polish note]

Najlepszy słownik angielsko-polski na czytniki, [Wielki Słownik Angielsko Polski](https://ebookpoint.pl/ksiazki/wielki-slownik-angielsko-polski-zastepuje-slownik-wbudowany-w-kindle-dariusz-jemielniak-marcin-milkowski-red,s_01jj.htm#format/e), jest dostępny wyłącznie w formatach dla Kindle i Pocketbook. Celem tego projektu jest umożliwienie korzystania z tego słownika na innych czytnikach, takich jak np. Onyx Boox, które obsługują format StarDict. Repozytorium zawiera tylko skrypt do konwersji, **słownik należy zakupić samodzielnie**. Jeżeli wystąpią błędy to daj znać, postaram się poprawić. 

Istnieją dwa konwertery w zależności od wersji słownika:

- [mobiKF8HuffConverter.html](https://random90.github.io/mobiDictToStarDictConverter/mobiKF8HuffConverter.html) - dla słownika w formacie KF8 (**nowsze wydania**), działa z wersją 2023-2026
- [mobi7PalmDocConverter.html](https://random90.github.io/mobiDictToStarDictConverter/mobi7PalmDocConverter.html) - dla słownika w formacie PalmDoc (**starsze wydania**), działa z wersją 2014 (i prawdopodobnie częcią aktualizcji)

Plik konwertera wysarczy otworzyć w nowym oknie przeglądarki, wybrać plik słownika i kliknąć Convert/Begin. Potem należy pobrać wygenerowane pliki osobno i umieścić w osobnym folderze w katalogu /dict (na Onyx Boox).

Oprócz samej konwersji, narzędzie oferuje **możliwość ulepszenia wyglądu słownika** poprzez wybór stylu wpisów, które oferują lepszą czytelność i estetykę na ekranach e-ink czarno-białych jak i kolorowych.

## 📋 Project description

One click offline web converter for .mobi kindle dictionaries to StarDict format. Just grab html file, select you dict and convert.
Main focus is to convert [Wielki Słownik Angielsko Polski](https://ebookpoint.pl/ksiazki/wielki-slownik-angielsko-polski-zastepuje-slownik-wbudowany-w-kindle-dariusz-jemielniak-marcin-milkowski-red,s_01jj.htm#format/e) to use on other e-readers like Onyx Boox, Kobo or KOReader app which support StarDict format. It might work with other dictionaries in .mobi format, but I've only tested it with that one.

The main motivation for this project was to build a simple tool I would use once for myself, then delete and forget. But I decided to have some fun, quickly build a page, and share it on GitHub.

Apart from the conversion itself, the tool offers **the ability to enhance the appearance of the dictionary** by choosing entry styles that provide better readability and aesthetics on both black-and-white and color e-ink screens.

The repository contains only the conversion script, the **dictionary must be purchased separately**.

Decompress algorithm is based on [KindleUnpack](https://github.com/kevinhendricks/KindleUnpack) python script, but completely rewritten in JavaScript to run in a browser.

## 🚀 Usage

Use one of the two converters depending on the version of your dictionary:

- [mobiKF8HuffConverter.html](https://random90.github.io/mobiDictToStarDictConverter/mobiKF8HuffConverter.html) - for KF8 format (newer editions)
- [mobi7PalmDocConverter.html](https://random90.github.io/mobiDictToStarDictConverter/mobi7PalmDocConverter.html) - for PalmDoc format (older editions)

Pick a mobi file, select StarDict entry style and click Convert/Begin. Then download the generated files separately and place them in a separate folder in the /dict directory of your reader (on Onyx Boox, might differ on others).

## 🧰 Additional tools

Repo contains some additional tools used to inspect and analyze the dictionary files, such as a simple HTML viewer for the .mobi files. These tools are meant to assist in understanding the structure of the .mobi files and to facilitate the conversion process. They are not essential for the conversion itself, but can be helpful for debugging and learning purposes.

### versionTester.html

Check the version of the .mobi file and shows some additional information about the file.

### MobiReader.html (Huff/PalmDoc)

Allows you to open and view the contents of a .mobi file in your browser. It provides a basic interface for navigating through the dictionary entries and inspecting the structure of the .mobi file. It shows raw HTML and rendered view side by side.

### StardictReaderValidator.html

Allows to view the converted StarDict files and validate the conversion process. It has a search functionality to quickly find specific entries and shows them in side by side view of raw HTML and rendered view.

## ⚠️ Disclaimer

This project is provided "as is" without any warranties. The conversion process may not be perfect and may result in some loss of formatting or functionality and is not intended for commercial use. The original dictionary is a paid product, and this project does not aim to distribute it in any way. It is solely meant to enable users who have legally purchased the dictionary to use it on different devices.

**No DRM removal is involved in this process**, the tool only extracts and converts the content of the .mobi file. Use at your own risk.

Also note that this tool has been basically written by vibe-coding. It's not the best way to write complicated software, but it useful for one-time use utilities like that. I don't know much about decompressing algorithms. It started out as a typical "google and do the monkey-see-monkey-do" kind of programming, but then I cut out the middle-man, **me**, and just used the LLM to write most of the code.

## 🛠️ Development

The HTML files served by GitHub Pages are **compiled outputs** - do not edit them directly. All source files live in the `src/` folder.

### 📁 Repository structure

```
src/
├── huffcdic-core.js                      # Shared HUFF/CDIC decompression (HuffCdicBase class)
├── palmdoc-core.js                       # Shared PalmDoc decompression (PalmDocBase class)
├── mobiKF8HuffConverter.template.html    # Template → mobiKF8HuffConverter.html
├── MobiReader-Huff-KF8.template.html     # Template → Tools/MobiReader-Huff-KF8.html
├── mobi7PalmDocConverter.template.html   # Template → mobi7PalmDocConverter.html
└── MobiReader-PalmDoc.template.html      # Template → Tools/MobiReader-PalmDoc.html

build.js                                  # Build script (Node.js, no dependencies)

mobiKF8HuffConverter.html                 # Compiled – KF8 converter (GitHub Pages)
mobi7PalmDocConverter.html                # Compiled – PalmDoc converter (GitHub Pages)
Tools/
├── MobiReader-Huff-KF8.html             # Compiled – KF8 inspector tool
├── MobiReader-PalmDoc.html              # Compiled – PalmDoc inspector tool
├── StarDictReaderValidator.html
└── versionTester.html
```

### ⚙️ Build system

The build script (`build.js`) is a zero-dependency Node.js script. It processes each template file and replaces `@@include` markers with the contents of the referenced source file:

```js
// @@include(src/huffcdic-core.js)
```

This allows the shared decompression logic to live in a single file while each compiled HTML remains fully self-contained (no runtime imports or external scripts needed).

To rebuild after any change:

```bash
node build.js
```

or with npm script:

```bash
npm run build
```

### ✏️ Making changes

| What you want to change | File to edit                                      |
| ----------------------- | ------------------------------------------------- |
| Add a new output file   | Add an entry to the `OUTPUTS` array in `build.js` |

After editing any template or shared source file, run `node build.js` and commit both the changed source files and the regenerated HTML files.

### 🪝 Git hooks

A pre-commit hook is included in `.githooks/pre-commit`. It automatically runs `node build.js` before every commit so compiled outputs are always up to date.

After cloning the repository, activate it once with:

```bash
npm run activate-hooks
```

This runs `git config core.hooksPath .githooks` locally (git does not share hook configuration automatically).
