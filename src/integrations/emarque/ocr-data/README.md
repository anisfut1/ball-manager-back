# Modèle Tesseract (OCR) — français

`fra.traineddata` provient du dépôt public
[tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)
(licence Apache 2.0), variante "fast" (plus petite, plus rapide que "best").

Vendorisé ici (plutôt que téléchargé à l'exécution depuis un CDN) pour deux
raisons :

1. **Fiabilité** : pas de dépendance réseau au moment du traitement d'un
   document e-Marque (voir `../extractors/pdf-raster-ocr-extractor.ts`).
2. **Vercel ne trace pas les fichiers lus dynamiquement** via `fs` (voir
   `docs/EMARQUE.md`, § sur le worker `pdfjs-dist` pour le même problème
   côté PDF) : ce fichier doit être physiquement présent dans le repo et
   déclaré dans `vercel.json` (`functions."api/index.ts".includeFiles`)
   pour finir dans le déploiement de la Function serverless qui en a
   besoin. Constaté en production le 2026-09-24 : ce fichier n'avait
   jamais été porté depuis ball-manager-web lors de la migration vers ce repo (§
   "Trentième déclenchement", docs/FBI.md) — `OCR_LANG_PATH` pointait vers
   un chemin `src/server/emarque/ocr-data` qui n'existe pas dans ce repo
   (convention Next.js de l'ancien monolithe, jamais celle de
   `ball-manager-back`).

Ce n'est pas une donnée du club ni un secret : c'est un modèle de langue
générique et public, comme une police de caractères.

Pour mettre à jour ce fichier :

```bash
curl -o fra.traineddata https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/fra.traineddata
```
