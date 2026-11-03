import { describe, expect, it } from "vitest";
import { emarqueDownloadUrl, executeSearchQuery, looksLikeZip, parseSearchResponse, pickRow, searchFormFields } from "./emarque-search.js";

/** Lignes au format EXACT de la réponse FBI capturée en production le 30/09 (rencontre n°6, 3 divisions). */
const row = (division: string, numero: string, em: string) => [
  `<a class=" imgPrint" onclick="genererConvocationSaisieOfficiel('false','200000014744254'); return false;" href='#'); style='margin-left: 0px;'><span></span></a>`,
  `<div class='alignGauche' title='${division}'>${division}</div>`,
  `<div style='text-align: right'>${numero}</div>`,
  "<div class=''>BASKET&nbsp;CLUB&nbsp;FLORENSAC&nbsp;-&nbsp;1&nbsp;(13)</div></div>",
  "<div class=''><div class='bold'>SPORT&nbsp;CLUB&nbsp;DE&nbsp;SETE&nbsp;BASKET&nbsp;-...</div></div>",
  "<div class='alignCentrer'>26/09/2026</div>",
  "<div class='alignCentrer'>13:30</div>",
  "HALLE&nbsp;DES&nbsp;SPORTS",
  em,
  "17",
  "<input type='checkbox' value='false' disabled='true'/>",
  "86",
  "<input type='checkbox' value='false' disabled='true'/>",
  "",
];
const emLink = (token: string, id: string) =>
  `<div class='alignCentrer' title='Télécharger les données du match e-Marque'><a class="emarquepictureafter emarqueV2${id}" onclick="telechargerMatch('${token}','${id}' )"></a>  </div>`;

const RESPONSE = JSON.stringify({
  iTotalRecords: 3,
  aaData: [
    row("BU11MN2", "6", emLink("FAKE00000000000000000000%3D%3D", "200000014744254")),
    row("BU15MN1", "6", emLink("FAKE000000000000000000%3D%3D", "200000014741703")),
    row("BU18MN2", "6", "<div class='alignCentrer'></div>"),
  ],
});

describe("recherche e-Marque directe FBI (retour du club, 2026-10-02 : matchs sans stats)", () => {
  it("lit division, numéro et jeton EM de chaque ligne", () => {
    const rows = parseSearchResponse(RESPONSE);
    expect(rows).toEqual([
      { division: "BU11MN2", matchNumber: "6", emarqueToken: "FAKE00000000000000000000%3D%3D", fbiMatchId: "200000014744254", emarqueV2: true },
      { division: "BU15MN1", matchNumber: "6", emarqueToken: "FAKE000000000000000000%3D%3D", fbiMatchId: "200000014741703", emarqueV2: true },
      { division: "BU18MN2", matchNumber: "6", emarqueToken: null, fbiMatchId: null, emarqueV2: false },
    ]);
  });

  it("choisit la ligne de LA bonne division — un même numéro existe dans plusieurs catégories", () => {
    const rows = parseSearchResponse(RESPONSE);
    expect(pickRow(rows, "6", "BU15MN1")?.emarqueToken).toBe("FAKE000000000000000000%3D%3D");
    expect(pickRow(rows, "6", "BU18MN2")?.emarqueToken).toBeNull();
    expect(pickRow(rows, "6", "DM2")).toBeNull();
    // Sans division connue : jamais un choix au hasard entre plusieurs lignes.
    expect(pickRow(rows, "6", null)).toBeNull();
    expect(pickRow(parseSearchResponse(JSON.stringify({ aaData: [rows.length && row("DM2", "9503", emLink("tok", "1"))] })), "9503", null)?.division).toBe("DM2");
    // Numéro EXACT : "6" ne correspond jamais à "16".
    expect(pickRow(parseSearchResponse(JSON.stringify({ aaData: [row("BU11FN23", "16", emLink("t", "2"))] })), "6", "BU11FN23")).toBeNull();
  });

  it("construit l'URL de téléchargement observée en production (jeton déjà encodé, jamais ré-encodé)", () => {
    expect(emarqueDownloadUrl("https://extranet.ffbb.com/fbi", "FAKE000000000000000000%3D%3D")).toBe(
      "https://extranet.ffbb.com/fbi/telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=FAKE000000000000000000%3D%3D",
    );
  });

  it("rejoue les mêmes champs que le formulaire, sans division (filtrée ensuite par ligne)", () => {
    const fields = searchFormFields({ seasonId: "1037", matchNumber: "9503" });
    expect(fields["rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.idSaison"]).toBe("1037");
    expect(fields["rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.idDivision"]).toBe("");
    expect(fields["rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.numeroRencontre"]).toBe("9503");
    const query = new URLSearchParams(executeSearchQuery({ seasonId: "1037", matchNumber: "9503" }, 1));
    expect(query.get("action")).toBe("executeRecherche");
    expect(query.get("iColumns")).toBe("14");
    expect(query.get("rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.numeroRencontre")).toBe("9503");
  });

  it("lève sur une réponse qui n'est pas du DataTables (l'appelant retombe sur le parcours à la souris)", () => {
    expect(() => parseSearchResponse("<html>session expirée</html>")).toThrow();
    expect(() => parseSearchResponse(JSON.stringify({ foo: 1 }))).toThrow();
  });

  it("reconnaît un ZIP — FBI renvoie du HTML quand le fichier n'est pas disponible", () => {
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    expect(looksLikeZip(Buffer.from("<html><body>Erreur</body></html>"))).toBe(false);
  });
});
