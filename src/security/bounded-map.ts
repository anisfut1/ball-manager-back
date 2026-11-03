/**
 * Borne une `Map` de limitation en mémoire : d'abord les entrées expirées
 * partent, puis, si elle dépasse encore `max`, les plus anciennes (ordre
 * d'insertion de la `Map`), même encore actives. À appeler avant d'ajouter
 * une entrée ; une clé qu'on réinsère doit d'abord être supprimée pour
 * repasser en fin d'ordre.
 */
export function boundMap<K, V>(map: Map<K, V>, max: number, isExpired: (value: V) => boolean): void {
  if (map.size < max) return;
  for (const [key, value] of map) if (isExpired(value)) map.delete(key);
  for (const key of map.keys()) {
    if (map.size < max) break;
    map.delete(key);
  }
}
