# 📖 Mobi to StarDict Dictionary Converter

🌐 **[Project website & live tools → random90.github.io/mobiDictToStarDictConverter](https://random90.github.io/mobiDictToStarDictConverter)**

## Recenzja na światczytnikow.pl

[https://swiatczytnikow.pl/konwerter-slownikow-z-formatu-mobi-na-stardict-obsluguje-wielki-slownik-angielsko-polski-i-slownik-jezyka-polskiego/](https://swiatczytnikow.pl/konwerter-slownikow-z-formatu-mobi-na-stardict-obsluguje-wielki-slownik-angielsko-polski-i-slownik-jezyka-polskiego/)

## 🇵🇱 Informacja o projekcie [Polish note]

Najlepszy słownik angielsko-polski na czytniki, [Wielki Słownik Angielsko Polski](https://ebookpoint.pl/ksiazki/wielki-slownik-angielsko-polski-zastepuje-slownik-wbudowany-w-kindle-dariusz-jemielniak-marcin-milkowski-red,s_01jj.htm#format/e), jest dostępny wyłącznie w formatach dla Kindle i Pocketbook. Celem tego projektu jest umożliwienie korzystania z tego i innych słowników na innych czytnikach, takich jak np. Onyx Boox, które obsługują format StarDict. Repozytorium zawiera tylko skrypt do konwersji, **słowniki należy zakupić samodzielnie**. Jeżeli wystąpią błędy to daj znać, postaram się poprawić.

**Od wersji v2 nie trzeba już wybierać konwertera ręcznie** - format jest wykrywany automatycznie po wczytaniu pliku.

Konwerter obsługuje też darmowy słownik języka polskiego SJP2, który jest dostępny na [https://cc-sjp.zabałaganionemiejsce.pl/](https://cc-sjp.zabałaganionemiejsce.pl/) oraz słowniki zbiorcze z [https://sowaczyta.pl/slowniki-zbiorcze/](https://sowaczyta.pl/slowniki-zbiorcze/) (np. `zbiorczy słownik czesko-polski`, `zbiorczy słownik włosko-polski`). Jeżeli posiadasz inny słownik w formacie .mobi, możesz spróbować go przekonwertować, ale nie gwarantuję, że będzie działać poprawnie.

Plik konwertera wystarczy otworzyć w nowym oknie przeglądarki, wybrać plik słownika i kliknąć "Rozpocznij konwersję". Potem należy pobrać wygenerowane pliki osobno i umieścić w osobnym folderze w katalogu /dict (na Onyx Boox; może się różnić na innych czytnikach).

Oprócz samej konwersji, narzędzie oferuje **możliwość ulepszenia wyglądu słownika** poprzez wybór stylu wpisów, które oferują lepszą czytelność i estetykę na ekranach e-ink czarno-białych jak i kolorowych.

## 📋 Project description

One click offline web converter for .mobi Kindle dictionaries to StarDict format. Just grab the HTML file, select your dictionary and convert. 

**Since v2 The format is detected automatically** - both KF8 and PalmDoc/Mobi7 are handled by a single converter.

Main focus is to convert [Wielki Słownik Angielsko Polski](https://ebookpoint.pl/ksiazki/wielki-slownik-angielsko-polski-zastepuje-slownik-wbudowany-w-kindle-dariusz-jemielniak-marcin-milkowski-red,s_01jj.htm#format/e) to use on other e-readers like Onyx Boox, Kobo or KOReader app which support StarDict format.

Apart from the conversion itself, the tool offers **the ability to enhance the appearance of the dictionary** by choosing entry styles that provide better readability and aesthetics on both black-and-white and color e-ink screens.

The repository contains only the conversion script, the **dictionary must be purchased separately**.

Decompress algorithm is based on [KindleUnpack](https://github.com/kevinhendricks/KindleUnpack) python script, but completely rewritten in JavaScript to run in a browser.

## 🚀 Usage

Open [mobiConverter.html](https://random90.github.io/mobiDictToStarDictConverter/mobiConverter.html), select your `.mobi` dictionary file and click **Start Conversion**. 

Then download the generated files and place them in a separate folder inside the `/dict` directory of your reader (on Onyx Boox; may differ on other readers).

## ✅ Compatibility (tested)

| Dictionary                            | Format | Notes |
|---------------------------------------|---|--|
| Wielki Słownik Angielsko-Polski 2023+ | **KF8** |  |
| e-słownik SJP2                        | **KF8** | from [cc-sjp.zabalaganionemiejsce.pl](https://cc-sjp.zabałaganionemiejsce.pl/) |
| Wielki Słownik Angielsko-Polski 2014  | **PalmDoc** |  |
| zbiorczy słownik czesko-polski        | **PalmDoc** | from [sowaczyta.pl/slowniki-zbiorcze](https://sowaczyta.pl/slowniki-zbiorcze/) |
| zbiorczy słownik włosko-polski        | **PalmDoc** | from [sowaczyta.pl/slowniki-zbiorcze](https://sowaczyta.pl/slowniki-zbiorcze/) |

If a dictionary uses a different internal HTML structure, conversion may still work, but please treat it as best-effort and verify the output with the included validator tool.

## 🧰 Additional tools

### versionTester.html

Check the version and compression format of any `.mobi` file and show internal metadata.

### MobiReader.html

Allows you to open and view the contents of a .mobi file in your browser. It provides a basic interface for navigating through the dictionary entries and inspecting the structure of the .mobi file. It shows raw HTML and rendered view side by side.

### StardictReaderValidator.html

Load converted StarDict files, search entries, and verify the conversion result.

## ⚠️ Disclaimer

This project is provided "as is" without any warranties. The conversion process may not be perfect and may result in some loss of formatting or functionality and is not intended for commercial use. The original dictionary is a paid product, and this project does not aim to distribute it in any way. It is solely meant to enable users who have legally purchased the dictionary to use it on different devices.

**No DRM removal is involved in this process**, the tool only extracts and converts the content of the .mobi file. Use at your own risk.

## 🛠️ Development

The HTML files served by GitHub Pages are **compiled outputs** - do not edit them directly. All source files live in the `src/` folder.

### 📁 Repository structure

```
src/
├── mobi-detect-core.js                # Shared format detection (detectMobiFormat)
├── huffcdic-core.js                   # HUFF/CDIC decompression (HuffCdicBase)
├── palmdoc-core.js                    # PalmDoc decompression (PalmDocBase)
├── mobi-index-core.js                 # MOBI INDX inflection index parser
├── kf8-converter.js                   # KF8 converter (KF8Converter)
├── palmdoc-converter.js               # PalmDoc converter (Converter)
├── stardict-dictzip-core.js           # StarDict dictzip compression
├── stardict-validator-core.js         # Inline StarDict validator widget
├── stardict-output.js                 # Unified StarDict output renderer
├── i18n-core.js                       # Shared i18n (EN/PL)
├── mobiConverter.template.html        # Template → mobiConverter.html
└── MobiReader.template.html           # Template → Tools/MobiReader.html

build.js                               # Build script (Node.js, no external deps)

mobiConverter.html                     # Compiled – unified converter (GitHub Pages)
Tools/
├── MobiReader.html                    # Compiled – unified MOBI inspector
├── StarDictReaderValidator.html       # Compiled – StarDict validator
└── versionTester.html                 # Standalone – format/version diagnostic
```

### ⚙️ Build system

The build script (`build.js`) processes each template and replaces `@@include` markers with the contents of the referenced source file:

```js
// @@include(src/huffcdic-core.js)
```

Each compiled HTML is fully self-contained, no runtime imports or external scripts needed.

To rebuild after any change:

```bash
node build.js
```

or with npm script:

```bash
npm run build
```

### ✏️ Making changes

| What you want to change | File to edit |
| ----------------------- | ------------ |
| Converter UI / logic    | `src/mobiConverter.template.html` |
| MOBI reader UI / logic  | `src/MobiReader.template.html` |
| KF8 decompression       | `src/huffcdic-core.js`, `src/kf8-converter.js` |
| PalmDoc decompression   | `src/palmdoc-core.js`, `src/palmdoc-converter.js` |
| Format detection        | `src/mobi-detect-core.js` |
| StarDict output         | `src/stardict-output.js` |
| Add a new output file   | Add an entry to `OUTPUTS` in `build.js` |

After editing any template or shared source file, run `node build.js` and commit both the changed source files and the regenerated HTML files.

### 🪝 Git hooks

A pre-commit hook is included in `.githooks/pre-commit`. It automatically runs `node build.js` before every commit so compiled outputs are always up to date.

After cloning the repository, activate it once with:

```bash
npm run activate-hooks
```

### 📊 Performance benchmarks

```bash
# KF8 dictionaries
node perf-test.mjs /path/to/dict.mobi [label]

# PalmDoc dictionaries
node perf-test-palmdoc.mjs /path/to/dict.mobi [label]
```