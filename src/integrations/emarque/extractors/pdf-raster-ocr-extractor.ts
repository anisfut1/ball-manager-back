import path from "node:path";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { loadPdfjs } from "./pdfjs-loader.js";
import type { DetectLinesOptions, DocumentExtractor, ExtractedText, ExtractZoneOptions, ZoneFraction } from "./types.js";

/**
 * Résolution de rendu. Calibré empiriquement (voir docs/
 * FBI_AUTHENTICATED_SPIKE.md et le travail de calibration mené sur
 * l'échantillon réel fourni) : 300dpi donne un texte lisible par Tesseract
 * sur les documents e-Marque V2, 150dpi est trop grossier pour les petites
 * cellules de tableau.
 */
const RENDER_SCALE = 300 / 72;

/**
 * Chemin du modèle de langue vendorisé (voir `../ocr-data/README.md`).
 * Résolu depuis `process.cwd()` (racine du repo dans une Function Vercel),
 * déclaré dans `vercel.json` (`functions."api/index.ts".includeFiles`) pour
 * finir physiquement dans le déploiement — Vercel ne trace jamais un
 * fichier lu dynamiquement via `fs` (voir `docs/EMARQUE.md`).
 *
 * Constaté en production le 2026-09-24 (§ "Trentième déclenchement",
 * docs/FBI.md) : ce chemin pointait vers `src/server/emarque/ocr-data`,
 * une convention Next.js de l'ancien monolithe ball-manager-web jamais adaptée lors de
 * la migration — ce dossier n'a jamais existé dans ball-manager-back, et le
 * fichier `fra.traineddata` lui-même n'avait jamais été porté.
 */
const OCR_LANG_PATH = path.join(process.cwd(), "src/integrations/emarque/ocr-data");

/**
 * Extraction par rendu image + OCR ciblé (Tesseract), pour les documents
 * e-Marque V2 : ils n'ont AUCUNE couche texte (confirmé sur l'échantillon
 * réel fourni — voir docs/FBI_AUTHENTICATED_SPIKE.md). Le rendu de chaque
 * page est mis en cache (une page peut être découpée en dizaines de zones :
 * en-tête, chaque ligne de l'effectif, table des officiels...).
 *
 * Statut : validé manuellement contre un vrai document e-Marque V2 pendant
 * le développement (rendu + OCR + extraction de plusieurs champs corrects,
 * dont un numéro de licence OTM). Non re-testé en CI (pas de fixture PDF
 * réelle committée, voir docs/FBI_AUTHENTICATED_SPIKE.md) : les tests
 * automatisés couvrent la couche de normalisation (regex) en aval, pas ce
 * rendu+OCR lui-même.
 */
export class PdfRasterOcrExtractor implements DocumentExtractor {
  readonly name = "pdf-raster-ocr";
  private readonly canvasCache = new Map<number, Canvas>();
  private workerPromise: Promise<Worker> | null = null;

  constructor(private readonly pdfBuffer: Buffer) {}

  private async getWorker(): Promise<Worker> {
    this.workerPromise ??= createWorker("fra", 1, { langPath: OCR_LANG_PATH, gzip: false }).then(async (worker) => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      return worker;
    });

    return this.workerPromise;
  }

  private async getPageCanvas(pageNumber: number): Promise<Canvas> {
    const cached = this.canvasCache.get(pageNumber);
    if (cached) return cached;

    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(this.pdfBuffer) }).promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    this.canvasCache.set(pageNumber, canvas);
    return canvas;
  }

  /**
   * Image PNG d'une zone, exactement telle que `extractZone` la découpe
   * (diagnostic, ops/emarque-debug — jamais appelé par le parsing).
   */
  async debugZonePng(pageNumber: number, zone: ZoneFraction): Promise<Buffer> {
    const pageCanvas = await this.getPageCanvas(pageNumber);
    const x = Math.round(zone.xFrac * pageCanvas.width);
    const y = Math.round(zone.yFrac * pageCanvas.height);
    const width = Math.max(Math.round(zone.widthFrac * pageCanvas.width), 1);
    const height = Math.max(Math.round(zone.heightFrac * pageCanvas.height), 1);
    const cropped = createCanvas(width, height);
    cropped.getContext("2d").drawImage(pageCanvas, x, y, width, height, 0, 0, width, height);
    return cropped.toBuffer("image/png");
  }

  async extractZone(pageNumber: number, zone: ZoneFraction, options?: ExtractZoneOptions): Promise<ExtractedText> {
    const pageCanvas = await this.getPageCanvas(pageNumber);

    const x = Math.round(zone.xFrac * pageCanvas.width);
    const y = Math.round(zone.yFrac * pageCanvas.height);
    const width = Math.round(zone.widthFrac * pageCanvas.width);
    const height = Math.round(zone.heightFrac * pageCanvas.height);

    const cropped = createCanvas(Math.max(width, 1), Math.max(height, 1));
    cropped.getContext("2d").drawImage(pageCanvas, x, y, width, height, 0, 0, width, height);

    const worker = await this.getWorker();
    const primary = await worker.recognize(cropped.toBuffer("image/png"));
    const primaryText = primary.data.text.trim();

    /**
     * Seconde passe ciblée sur une cellule censée être numérique
     * (`expectDigitsOnly`), dans deux cas : AUCUN chiffre trouvé, ou UN SEUL
     * chiffre trouvé (voir plus bas pourquoi ce second cas a été ajouté) —
     * jamais si plusieurs chiffres DIFFÉRENTS ont déjà été lus, où le repli
     * n'apporterait rien de plus fiable.
     *
     * Mesuré en production (rencontre n°1481, § "Trente-et-unième
     * déclenchement", docs/FBI.md) sur un échantillon de 120 cellules
     * réelles, ce repli fait passer le taux de lecture correcte de 83,3 % à
     * 89,2 %, en corrigeant notamment presque toutes les cellules à "0"
     * (glyphe fin, souvent illisible à l'échelle de rendu normale) — jamais
     * tenté EN PREMIER : appliquer d'emblée l'alphabet restreint aux
     * chiffres dégrade la lecture d'un "1" isolé (le moteur LSTM semble
     * avoir besoin du contexte non contraint pour ce glyphe précis, constaté
     * sur le même échantillon).
     */
    const primaryIsSingleDigit = /^\d$/.test(primaryText);
    if (options?.expectDigitsOnly && (!/\d/.test(primaryText) || primaryIsSingleDigit)) {
      const upscale = 2;
      const upscaled = createCanvas(cropped.width * upscale, cropped.height * upscale);
      const upscaledCtx = upscaled.getContext("2d");
      upscaledCtx.imageSmoothingEnabled = false;
      const image = await loadImage(cropped.toBuffer("image/png"));
      upscaledCtx.drawImage(image, 0, 0, upscaled.width, upscaled.height);

      // ":" toléré (jamais imposé) même si cette cellule n'est pas la
      // colonne "Tps de jeu" : inoffensif pour une cellule purement
      // numérique (ne matchera jamais), évite un second flag dédié au
      // format "mm:ss".
      await worker.setParameters({ tessedit_char_whitelist: "0123456789:" });
      const retry = await worker.recognize(upscaled.toBuffer("image/png"));
      // Restaure IMMÉDIATEMENT l'alphabet libre : ce worker est PARTAGÉ et
      // réutilisé séquentiellement pour toutes les zones suivantes (y
      // compris du texte libre, ex. une colonne NOM Prénom) — un alphabet
      // resté restreint aux chiffres corromprait silencieusement leur
      // lecture.
      await worker.setParameters({ tessedit_char_whitelist: "" });

      const retryText = retry.data.text.trim();

      /**
       * Constaté DEUX FOIS en production sur la même rencontre (n°1481) :
       * un nombre à deux chiffres IDENTIQUES ("11") est parfois fusionné par
       * l'OCR en un seul glyphe reconnu comme CE chiffre isolé ("1") — une
       * fois sur un numéro de maillot (§ "Trente-cinquième déclenchement",
       * docs/FBI.md, corrigé côté rapprochement dans `merge.ts` faute de
       * mieux à l'époque), une fois sur une statistique
       * (`twoPointsInteriorMade`, signalée directement par le club : "2int
       * c'est 11 pas 1"). Le repli ci-dessus (agrandissement 2×) suffit
       * souvent à séparer les deux glyphes fusionnés — mais seulement
       * accepté ici s'il révèle EXACTEMENT ce même chiffre RÉPÉTÉ ("11",
       * "22"... jamais un chiffre différent) : le repli lui-même est connu
       * pour être moins fiable qu'une lecture normale sur un "1" isolé
       * (voir plus haut), donc on ne le laisse jamais remplacer une lecture
       * par autre chose qu'une correction de CE bug précis.
       */
      if (primaryIsSingleDigit) {
        const repeatedDigitPattern = new RegExp(`^${primaryText}{2,}$`);
        if (repeatedDigitPattern.test(retryText)) return { text: retryText, confidence: retry.data.confidence };
        return { text: primaryText, confidence: primary.data.confidence };
      }

      if (/\d/.test(retryText)) return { text: retryText, confidence: retry.data.confidence };
    }

    return { text: primaryText, confidence: primary.data.confidence };
  }

  /**
   * Détecte les lignes de grille HORIZONTALES du tableau dans `zone`, en
   * scannant chaque rangée de pixels pour une fraction sombre (texte noir
   * sur fond blanc d'un document e-Marque) au-delà d'`options.minDarknessFraction`
   * — une ligne de grille pleine largeur (contrairement à une lettre isolée)
   * produit une rangée QUASI ENTIÈREMENT sombre. Validé pixel par pixel
   * contre DEUX documents réels de compétitions différentes (rencontre 1481
   * et rencontre 6 vs Agde Basket, docs/EMARQUE.md "Correctifs d'import") :
   * les lignes détectées correspondent, à 1-2px près, aux bordures de
   * tableau visibles à l'œil sur les deux, malgré des effectifs différents
   * (8+7 puis 12+8 joueurs) — c'est précisément cette variation d'effectif
   * qui rendait un calibrage à coordonnées FIXES incorrect (voir
   * `layout/table-structure.ts`).
   */
  async detectHorizontalLines(pageNumber: number, zone: ZoneFraction, options?: DetectLinesOptions): Promise<number[]> {
    const pageCanvas = await this.getPageCanvas(pageNumber);

    const x = Math.round(zone.xFrac * pageCanvas.width);
    const y = Math.round(zone.yFrac * pageCanvas.height);
    const width = Math.max(Math.round(zone.widthFrac * pageCanvas.width), 1);
    const height = Math.max(Math.round(zone.heightFrac * pageCanvas.height), 1);

    const ctx = pageCanvas.getContext("2d");
    const { data } = ctx.getImageData(x, y, width, height);
    const minDarkness = options?.minDarknessFraction ?? 0.5;

    const lines: number[] = [];
    let inLine = false;
    let lineStart = 0;

    for (let row = 0; row < height; row++) {
      let darkCount = 0;
      const rowOffset = row * width * 4;
      for (let col = 0; col < width; col++) {
        const idx = rowOffset + col * 4;
        // Luminance perceptuelle (ITU-R BT.601) — indifférent à la couleur exacte, seul le contraste noir/blanc du tableau compte ici.
        const luminance = 0.299 * data[idx]! + 0.587 * data[idx + 1]! + 0.114 * data[idx + 2]!;
        if (luminance < 128) darkCount += 1;
      }

      const isDark = darkCount / width >= minDarkness;
      if (isDark && !inLine) {
        inLine = true;
        lineStart = row;
      } else if (!isDark && inLine) {
        inLine = false;
        lines.push((y + Math.round((lineStart + row - 1) / 2)) / pageCanvas.height);
      }
    }
    if (inLine) {
      lines.push((y + Math.round((lineStart + height - 1) / 2)) / pageCanvas.height);
    }

    return lines;
  }

  async dispose(): Promise<void> {
    this.canvasCache.clear();

    if (this.workerPromise) {
      const worker = await this.workerPromise;
      await worker.terminate();
      this.workerPromise = null;
    }
  }
}
