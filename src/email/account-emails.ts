import { PLATFORM_NAME, renderEmail } from "./layout.js";

/**
 * Emails de compte (invitation, accès ajouté, mot de passe oublié) — envoyés
 * par Resend depuis le domaine de la plateforme, jamais par Supabase Auth
 * (retour du club, 2026-10-08 : « pourquoi une invit Supabase ? Faut un mail
 * propre »). Les liens pointent vers le frontend (`/bienvenue`), jamais vers
 * un domaine tiers.
 */
export interface ClubBranding {
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
}

export function buildInviteEmail(input: { club: ClubBranding; roleLabel: string; link: string }) {
  const subject = `Invitation : ${input.club.name} sur ${PLATFORM_NAME}`;
  const { html, text } = renderEmail({
    preheader: `Crée ton mot de passe pour accéder à ${input.club.name}.`,
    eyebrow: input.club.name,
    title: "Ton accès est prêt",
    paragraphs: [
      `Tu as été ajouté·e à ${input.club.name} sur ${PLATFORM_NAME} en tant que ${input.roleLabel}.`,
      "Il ne reste qu'une étape : choisir ton mot de passe. Ensuite, tu te connectes simplement avec ton email.",
    ],
    button: { label: "Créer mon mot de passe", href: input.link },
    footer: [
      `Tu reçois cet email parce qu'un responsable de ${input.club.name} a indiqué cette adresse.`,
      "Le lien est à usage unique. S'il a expiré, utilise « Mot de passe oublié » sur la page de connexion.",
      "Si tu ne t'attendais pas à cet email, ignore-le simplement : aucun accès ne sera créé sans clic.",
    ],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

export function buildAccessGrantedEmail(input: { club: ClubBranding; roleLabel: string; link: string }) {
  const subject = `Nouvel accès : ${input.club.name}`;
  const { html, text } = renderEmail({
    preheader: `Tu es maintenant ${input.roleLabel} de ${input.club.name}.`,
    eyebrow: input.club.name,
    title: `Tu es maintenant ${input.roleLabel}`,
    paragraphs: [`Ton compte ${PLATFORM_NAME} a désormais accès à ${input.club.name} en tant que ${input.roleLabel}.`, "Connecte-toi avec ton email et ton mot de passe habituels."],
    button: { label: `Ouvrir ${input.club.name}`, href: input.link },
    footer: [`Tu reçois cet email parce qu'un responsable a modifié tes accès à ${input.club.name}.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

export function buildPasswordResetEmail(input: { link: string }) {
  const subject = `Ton nouveau mot de passe ${PLATFORM_NAME}`;
  const { html, text } = renderEmail({
    preheader: "Choisis un nouveau mot de passe en un clic.",
    eyebrow: PLATFORM_NAME,
    title: "Nouveau mot de passe",
    paragraphs: ["Tu as demandé à changer ton mot de passe. Clique sur le bouton pour en choisir un nouveau."],
    button: { label: "Choisir un nouveau mot de passe", href: input.link },
    footer: ["Le lien est à usage unique et expire rapidement.", "Si ce n'est pas toi, ignore cet email : ton mot de passe actuel reste valable."],
  });
  return { subject, html, text };
}

/**
 * « Je ne trouve pas mon nom » (espace public, retour du club 2026-10-08) :
 * prévient les administrateurs du club. « Répondre » écrit directement à la
 * personne (Reply-To = son adresse).
 */
export function buildAccessRequestEmail(input: { club: ClubBranding; fullName: string; email: string; message: string | null; link: string }) {
  const subject = `${input.fullName} ne trouve pas son nom — ${input.club.name}`;
  const { html, text } = renderEmail({
    preheader: `Demande d'accès à l'espace public de ${input.club.name}.`,
    eyebrow: input.club.name,
    title: "Demande d'accès",
    paragraphs: [
      `${input.fullName} n'a pas trouvé son nom dans la liste des licenciés de l'espace public.`,
      `Adresse indiquée : ${input.email}`,
      ...(input.message ? [`Son message : « ${input.message} »`] : []),
      "Ajoute ou corrige sa fiche (nom, prénom, email) dans la liste des joueurs, puis réponds-lui : « Répondre » écrit directement à son adresse.",
    ],
    button: { label: "Ouvrir la liste des joueurs", href: input.link },
    footer: [`Tu reçois cet email parce que tu es administrateur de ${input.club.name} sur ${PLATFORM_NAME}.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

/** Lien demandé vers une adresse différente de celle de la fiche : l'admin valide ou refuse (rien n'est envoyé avant). */
export function buildClaimRequestEmail(input: { club: ClubBranding; licencieName: string; email: string; knownEmail: string; link: string }) {
  const subject = `Lien demandé pour ${input.licencieName} — à valider`;
  const { html, text } = renderEmail({
    preheader: `Quelqu'un demande le lien personnel de ${input.licencieName}.`,
    eyebrow: input.club.name,
    title: "Demande de lien à valider",
    paragraphs: [
      `Quelqu'un a choisi la fiche de ${input.licencieName} dans l'espace public et demande que son lien personnel soit envoyé à ${input.email}.`,
      `Sa fiche a déjà une autre adresse (${input.knownEmail}) : rien n'a été envoyé. Si la nouvelle adresse est bien la sienne, approuve la demande (elle remplacera l'ancienne sur sa fiche) ; sinon, refuse-la.`,
    ],
    button: { label: "Voir les demandes", href: input.link },
    footer: [`Tu reçois cet email parce que tu es administrateur de ${input.club.name} sur ${PLATFORM_NAME}. Sans réponse, la demande expire après 14 jours.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

/**
 * Nouvelle demande de dérogation d'un coach (ou nouveau créneau reproposé) —
 * retour du club, 2026-10-08 : « si c'est un coach qui fait une demande, ça
 * envoie un mail au coordinateur, avec le lien pour gérer ça ».
 */
export function buildDerogationRequestEmail(input: {
  club: ClubBranding;
  kind: "created" | "reproposed";
  requesterName: string;
  matchLabel: string;
  slotLabel: string;
  comment: string | null;
  link: string;
}) {
  const verb = input.kind === "created" ? "demande une dérogation" : "propose un nouveau créneau";
  const subject = `${input.requesterName} ${verb} — ${input.matchLabel}`;
  const { html, text } = renderEmail({
    preheader: `Créneau demandé : ${input.slotLabel}.`,
    eyebrow: input.club.name,
    title: input.kind === "created" ? "Nouvelle demande de dérogation" : "Nouveau créneau proposé",
    paragraphs: [
      `${input.requesterName} ${verb} pour ${input.matchLabel}.`,
      `Créneau demandé : ${input.slotLabel}.`,
      ...(input.comment ? [`Son message : « ${input.comment} »`] : []),
      "Ouvre la demande pour la prendre en charge, répondre ou indiquer que ce n'est pas possible.",
    ],
    button: { label: "Gérer la demande", href: input.link },
    footer: [`Tu reçois cet email parce que tu es coordinateur des dérogations de ${input.club.name} sur ${PLATFORM_NAME}.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

/**
 * Dérogations FBI à traiter (retour du club, 2026-10-08) : demandes du club
 * adverse qui attendent notre réponse, et réponses reçues sur nos propres
 * demandes. Un seul email par vérification, même s'il y en a plusieurs.
 */
export function buildFbiDerogationDigestEmail(input: { club: ClubBranding; incoming: string[]; outcomes: string[]; link: string }) {
  const parts: string[] = [];
  if (input.incoming.length > 0) parts.push(input.incoming.length > 1 ? `${input.incoming.length} dérogations à traiter` : "1 dérogation à traiter");
  if (input.outcomes.length > 0) parts.push(input.outcomes.length > 1 ? `${input.outcomes.length} réponses reçues` : "1 réponse reçue");
  const subject = `FBI : ${parts.join(", ")} — ${input.club.name}`;
  const { html, text } = renderEmail({
    preheader: input.incoming.length > 0 ? "Un club adverse attend ta réponse sur FBI." : "Une dérogation a reçu une réponse sur FBI.",
    eyebrow: input.club.name,
    title: input.incoming.length > 0 ? "Dérogation à traiter" : "Réponse à une dérogation",
    paragraphs: [
      ...(input.incoming.length > 0 ? ["Le club adverse demande à déplacer un match, ta réponse est attendue :", ...input.incoming.map((line) => `• ${line}`)] : []),
      ...(input.outcomes.length > 0 ? ["Réponse reçue sur FBI :", ...input.outcomes.map((line) => `• ${line}`)] : []),
      ...(input.incoming.length > 0 ? ["Accepte ou refuse directement depuis Ball Manager : la réponse est transmise à la FFBB."] : []),
    ],
    button: { label: input.incoming.length > 0 ? "Répondre à la dérogation" : "Voir les dérogations", href: input.link },
    footer: [`Tu reçois cet email parce que tu es coordinateur des dérogations de ${input.club.name} sur ${PLATFORM_NAME}. Vérification automatique sur FBI chaque jour.`],
    accentColor: input.club.accentColor,
    logoUrl: input.club.logoUrl,
  });
  return { subject, html, text };
}

/** Code de vérification à 6 chiffres (création de compte, web et app iOS). */
export function buildSignupCodeEmail(input: { code: string; link: string }) {
  const subject = `${input.code} est ton code ${PLATFORM_NAME}`;
  const { html, text } = renderEmail({
    preheader: "Ton code pour terminer la création de ton compte.",
    eyebrow: PLATFORM_NAME,
    title: "Ton code de vérification",
    paragraphs: ["Saisis ce code pour terminer la création de ton compte :", input.code],
    button: { label: "Ouvrir Ball Manager", href: input.link },
    footer: ["Le code expire dans 30 minutes.", "Si tu n'as pas demandé de compte, ignore cet email."],
  });
  return { subject, html, text };
}

/** Création de compte avec une adresse déjà inscrite : on le dit à la personne, jamais à celui qui a tapé l'adresse. */
export function buildAlreadyRegisteredEmail(input: { link: string }) {
  const subject = `Tu as déjà un compte ${PLATFORM_NAME}`;
  const { html, text } = renderEmail({
    preheader: "Connecte-toi avec ton mot de passe, ou choisis-en un nouveau.",
    eyebrow: PLATFORM_NAME,
    title: "Tu as déjà un compte",
    paragraphs: ["Quelqu'un (sans doute toi) a voulu créer un compte avec cette adresse, mais elle en a déjà un. Connecte-toi avec ton mot de passe habituel.", "Mot de passe oublié ? Choisis « Mot de passe oublié » sur l'écran de connexion."],
    button: { label: "Ouvrir Ball Manager", href: input.link },
    footer: ["Si ce n'est pas toi, ignore cet email : rien n'a changé sur ton compte."],
  });
  return { subject, html, text };
}
