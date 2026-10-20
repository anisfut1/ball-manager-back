import type { Locator, Page, Request, Response } from "playwright-core";
import type { BrowserFbiClient, BrowserFbiSession } from "../../src/integrations/fbi/browser-client.js";
import * as selectors from "../../src/integrations/fbi/selectors.js";

/**
 * Relevé en LECTURE SEULE (2026-10-20) de la modification de salle du
 * formulaire de création de dérogation FBI : case « Modifier la salle »,
 * fenêtre de recherche de gymnase (`rechercherModaleSalle()`), recherche,
 * choix d'un résultat — puis on QUITTE la page. Le bouton « Enregistrer »
 * n'est jamais touché : rien n'est créé ni modifié sur FBI.
 *
 * Déclenché par `platform_settings.fbi_capture_request = "salle"` ; le
 * résultat (HTML des étapes, requêtes réseau de la fenêtre, champs salle
 * après le choix) est rangé dans `platform_settings.fbi_capture_salle`.
 */
interface PrivateClient {
  navigateToDerogationSearchScreen(page: Page, etat: "tousLesEtats" | "creer"): Promise<void>;
  resolveDerogationScope(page: Page): Promise<{ scope: Page | Locator; found: boolean }>;
  derogationRowDetailHref(scope: Page | Locator, rowIndex: number): Promise<string | null>;
}

interface NetworkEntry {
  method: string;
  url: string;
  postData: string | null;
  status?: number;
  contentType?: string | null;
  body?: string | null;
}

const MAX_HTML = 250_000;
const MAX_BODY = 40_000;
const SEARCH_TERM = process.env.FBI_CAPTURE_SALLE_TERM || "CLAVEL";

const cut = (text: string | null | undefined, max: number) => (text && text.length > max ? `${text.slice(0, max)}… (tronqué, ${text.length})` : (text ?? null));

async function snapshot(page: Page, name: string) {
  const html = await page.content().catch(() => "");
  const fields = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input, select, button, a[onclick], img[onclick]"))
        .filter((el) => /salle|modal|recherch/i.test(`${el.getAttribute("name") ?? ""} ${el.id} ${el.getAttribute("onclick") ?? ""} ${el.className}`))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
          value: (el as HTMLInputElement).value ?? null,
          onclick: el.getAttribute("onclick"),
          disabled: (el as HTMLInputElement).disabled ?? null,
          visible: (el as HTMLElement).offsetParent !== null,
          text: (el.textContent ?? "").trim().slice(0, 80),
        })),
    )
    .catch(() => []);
  return { name, url: page.url(), fields, html: cut(html, MAX_HTML) };
}

export async function captureSalleForm(client: BrowserFbiClient, session: BrowserFbiSession, baseUrl: string): Promise<Record<string, unknown>> {
  const { page } = session;
  const priv = client as unknown as PrivateClient;
  const steps: Awaited<ReturnType<typeof snapshot>>[] = [];
  const network: NetworkEntry[] = [];
  const notes: string[] = [];

  const onRequest = (request: Request) => {
    if (["document", "xhr", "fetch"].includes(request.resourceType())) network.push({ method: request.method(), url: request.url(), postData: cut(request.postData(), 4_000) });
  };
  const onResponse = async (response: Response) => {
    const request = response.request();
    if (!["document", "xhr", "fetch"].includes(request.resourceType())) return;
    const entry = [...network].reverse().find((n) => n.url === request.url() && n.status === undefined);
    if (!entry) return;
    entry.status = response.status();
    entry.contentType = response.headers()["content-type"] ?? null;
    if (/html|json|text|javascript/.test(entry.contentType ?? "")) entry.body = cut(await response.text().catch(() => null), MAX_BODY);
  };

  try {
    // 1. Une rencontre « A Créer » : le premier lien de la liste.
    await priv.navigateToDerogationSearchScreen(page, "creer");
    const submit = selectors.searchSubmitControl(page).first();
    if ((await submit.count().catch(() => 0)) > 0) await submit.click();
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const { scope } = await priv.resolveDerogationScope(page);
    const rows = await selectors.resultsTableGenericRows(scope);
    notes.push(`${rows?.length ?? 0} rencontre(s) « A Créer » listée(s)`);
    const href = rows && rows.length > 0 ? await priv.derogationRowDetailHref(scope, 0) : null;
    if (!href) return { at: new Date().toISOString(), ok: false, notes: [...notes, "aucun lien de création trouvé"], steps: [await snapshot(page, "liste_a_creer")] };

    await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);
    const creation = await page.locator("input#creation").getAttribute("value").catch(() => null);
    notes.push(`formulaire de création : input#creation=${creation}`);
    steps.push(await snapshot(page, "formulaire"));

    page.on("request", onRequest);
    page.on("response", onResponse);

    // 2. Case « Modifier la salle ».
    await page.locator("#modifierSalle").check().catch((error: unknown) => notes.push(`case modifierSalle : ${String(error).slice(0, 200)}`));
    await page.waitForTimeout(1_000);
    steps.push(await snapshot(page, "salle_cochee"));

    // 3. Ouverture de la fenêtre de recherche de gymnase.
    const opener = page.locator('[onclick*="rechercherModaleSalle"]').first();
    if ((await opener.count().catch(() => 0)) > 0) {
      await opener.click().catch((error: unknown) => notes.push(`ouverture fenêtre : ${String(error).slice(0, 200)}`));
    } else {
      notes.push("aucun élément onclick=rechercherModaleSalle : appel direct de la fonction");
      await page.evaluate(() => (window as unknown as { rechercherModaleSalle?: () => void }).rechercherModaleSalle?.()).catch((error: unknown) => notes.push(`rechercherModaleSalle() : ${String(error).slice(0, 200)}`));
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    steps.push(await snapshot(page, "fenetre_ouverte"));

    // 4. Recherche par NOM (2e relevé, 2026-10-20 : le premier champ visible
    // de la fenêtre est « N° de la salle », d'où 0 résultat). Attention : la
    // fenêtre a son propre `#nomSalle`, homonyme du champ du formulaire —
    // toujours sélectionné par son `name`.
    const searchInput = page.locator('input[name="rechercherSalleModaleForm.rechercherSalleModaleBean.nomSalle"]').first();
    if ((await searchInput.count().catch(() => 0)) > 0) {
      await searchInput.fill(SEARCH_TERM);
      await page.locator("#rechercherModale").click().catch(async () => {
        await page.evaluate(() => (window as unknown as { rechercherSalleModaleAjax?: () => void }).rechercherSalleModaleAjax?.());
      });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      steps.push(await snapshot(page, "recherche_faite"));
      const resultsHtml = await page.locator("#tableauResultatsSalle").innerHTML().catch(() => null);
      notes.push(`résultats : ${cut(resultsHtml, 200)}`);

      // 5. Choix du premier résultat (remplit le formulaire en mémoire seulement).
      const result = page.locator("#rechercheSalleModaleAjax tbody tr a, #rechercheSalleModaleAjax tbody tr [onclick], #rechercheSalleModaleAjax tbody tr").first();
      if ((await result.count().catch(() => 0)) > 0) {
        const rowHtml = await page.locator("#rechercheSalleModaleAjax tbody tr").first().evaluate((el) => el.outerHTML).catch(() => null);
        notes.push(`première ligne : ${cut(rowHtml, 3_000)}`);
        await result.click().catch((error: unknown) => notes.push(`choix du résultat : ${String(error).slice(0, 200)}`));
        await page.waitForTimeout(1_500);
        steps.push(await snapshot(page, "resultat_choisi"));
      } else notes.push("aucun résultat cliquable dans la fenêtre");
    } else notes.push("champ « Nom » de la fenêtre introuvable");

    // Code des fonctions de la page qui touchent à la salle (sélection, réinitialisation).
    const salleFunctions = await page
      .evaluate(() => {
        const out: Record<string, string> = {};
        for (const key of Object.keys(window)) {
          if (!/salle/i.test(key)) continue;
          const value = (window as unknown as Record<string, unknown>)[key];
          if (typeof value === "function") out[key] = String(value).slice(0, 4_000);
        }
        return out;
      })
      .catch(() => null);

    const salleAfter = await page
      .evaluate(() => ({
        idSalle: (document.querySelector("#idSalle") as HTMLInputElement | null)?.value ?? null,
        nomSalle: (document.querySelector("#nomSalle") as HTMLInputElement | null)?.value ?? null,
      }))
      .catch(() => null);
    return { at: new Date().toISOString(), ok: true, searchTerm: SEARCH_TERM, notes, salleAfter, salleFunctions, steps, network };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    // On quitte le formulaire sans l'enregistrer.
    await page.goto(`${baseUrl}/accueil.fbi`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  }
}
