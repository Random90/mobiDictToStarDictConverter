# Mobi to StarDict Dictionary Converter

## Informacja o projekcie [Polish note]


Najlepszy słownik angielsko-polski na czytniki, [Wielki Słownik Angielsko Polski](https://ebookpoint.pl/ksiazki/wielki-slownik-angielsko-polski-zastepuje-slownik-wbudowany-w-kindle-dariusz-jemielniak-marcin-milkowski-red,s_01jj.htm#format/e), jest dostępny wyłącznie w formatach dla Kindle i Pocketbook. Celem tego projektu jest umożliwienie korzystania z tego słownika na innych czytnikach, takich jak np. Onyx Boox, które obsługują format StarDict. Repozytorium zawiera tylko skrypt do konwersji, słownik należy zakupić samodzielnie. Nie gwarantuję pełnej kompatybilności, projekt jest eksperymentalny. 

Istnieją dwa konwertery w zależności od wersji słownika:
 - mobiKF8HuffConverter.html - dla słownika w formacie KF8 (nowsze wydania), działa z wersją 2026
 - mobi7PalmDocConverter.html - dla słownika w formacie PalmDoc (starsze wydania), działa z wersją 2014 (i prawdopodobnie częcią aktualizcji)

Plik konwertera wysarczy otworzyć w nowym oknie przeglądarki, wybrać plik słownika i kliknąć Convert/Begin. Potem należy pobrać wygenerowane pliki osobno i umieścić w osobnym folderze w katalogu /dict (na Onyx Boox).

## Project description
One click offline web converter for .mobi kindle dictionaries to StarDict format. Just grab html file, select you dict and covert.
Main focus is to convert [Wielki Słownik Angielsko Polski](https://ebookpoint.pl/ksiazki/wielki-slownik-angielsko-polski-zastepuje-slownik-wbudowany-w-kindle-dariusz-jemielniak-marcin-milkowski-red,s_01jj.htm#format/e) to use on other e-readers like Onyx Boox, which support StarDict format. The repository contains only the conversion script, the dictionary must be purchased separately. Compatibility is not guaranteed, the project is experimental.

Decompress algorithm is based on [KindleUnpack](https://github.com/kevinhendricks/KindleUnpack) python script, but completely rewritten in JavaScript to run in a browser. It is not a direct port, but rather a new implementation inspired by the original. 

## Usage
Use one of the two converters depending on the version of your dictionary:
 - mobiKF8HuffConverter.html - for KF8 format (newer editions)
 - mobi7PalmDocConverter.html - for PalmDoc format (older editions)

Pick a mobi file, select StarDict entry style and click Convert/Begin. Then download the generated files separately and place them in a separate folder in the /dict directory of your reader (on Onyx Boox, might differ on others).


## Additional tools
Repo contains some additional tools used to inspect and analyze the dictionary files, such as a simple HTML viewer for the .mobi files. These tools are meant to assist in understanding the structure of the .mobi files and to facilitate the conversion process. They are not essential for the conversion itself, but can be helpful for debugging and learning purposes.

### versionTester.html
Check the version of the .mobi file and shows some additional information about the file.

### MobiReader.html (Huff/PalmDoc)
Allows you to open and view the contents of a .mobi file in your browser. It provides a basic interface for navigating through the dictionary entries and inspecting the structure of the .mobi file. It shows raw HTML and rendered view side by side.

### StardictReaderValidator.html
Allows to view the converted StarDict files and validate the conversion process. It has a search functionality to quickly find specific entries and shows them in side by side view of raw HTML and rendered view. 

## Disclaimer
This project is provided "as is" without any warranties. The conversion process may not be perfect and may result in some loss of formatting or functionality and is not intended for commercial use. The original dictionary is a paid product, and this project does not aim to distribute it in any way. It is solely meant to enable users who have legally purchased the dictionary to use it on different devices.


**No DRM removal is involved in this process**, the tool only extracts and converts the content of the .mobi file. Use at your own risk.

Also note that this tool has been basically written by vibe-coding. It's not the best way to write complicated software, but it useful for one use utilities like that. I don't know much about decompressing algorithms. It started out as a typical "google and do the monkey-see-monkey-do" kind of programming, but then I cut out the middle-man,*me*, and just used the LLM to write most of the code. 