/**
 * Lecture bornée du corps d'une réponse pour la capture réseau de diagnostic
 * (§ "Vingt-septième déclenchement", docs/FBI.md).
 *
 * Quand la page navigue juste après la réponse (soumission du formulaire), la
 * lecture `response.text()` peut ne JAMAIS se terminer : sans borne, la requête
 * n'était jamais consignée et la trace perdait toute la capture réseau (B3).
 * Ici : texte, ou `null` (échec, corps vide, ou délai dépassé) — jamais bloquant.
 */
export async function readBodyWithin(read: () => Promise<string>, timeoutMs: number): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const text = await Promise.race([read().catch(() => null), timeout]);
    return text ? text : null;
  } finally {
    clearTimeout(timer);
  }
}
