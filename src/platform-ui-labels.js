// Localized third-party platform labels used only for browser automation selectors.
const LABELS = {
  create: ["create", "erstellen"],
  instagramPostFormat: ["post", "beitrag"],
  instagramReelFormat: ["reel", "reels"],
  instagramUploadTrigger: ["from computer", "select from computer", "vom computer", "ausw\u00e4hlen"],
  next: ["next", "weiter"],
  captionAttribute: ["caption", "beschreib"],
  share: ["share", "post", "publish", "teilen", "posten"],
  posted: ["shared", "posted", "geteilt", "ver\u00f6ffentlicht", "beitrag wurde geteilt"],
  error: ["error", "failed", "couldn't", "fehler", "nicht m\u00f6glich", "konnte nicht"],

  youtubeCreate: ["create", "erstellen", "criar"],
  youtubeUploadVideo: [
    "upload videos",
    "upload video",
    "videos hochladen",
    "video hochladen",
    "enviar videos",
    "enviar v\u00eddeos",
  ],
  youtubeSelectFiles: ["select files", "dateien ausw\u00e4hlen", "selecionar arquivos"],
  youtubeNext: ["next", "weiter", "pr\u00f3ximo", "avancar", "avan\u00e7ar"],
  youtubeTitleAttribute: ["title", "titel", "titulo", "t\u00edtulo"],
  youtubeDescriptionAttribute: [
    "description",
    "beschreibung",
    "descricao",
    "descri\u00e7\u00e3o",
  ],
  youtubeNotMadeForKids: [
    "not made for kids",
    "nicht fur kinder",
    "nicht f\u00fcr kinder",
    "nicht speziell fur kinder",
    "nicht speziell f\u00fcr kinder",
    "nao e conteudo para criancas",
    "n\u00e3o \u00e9 conte\u00fado para crian\u00e7as",
    "n\u00e3o, n\u00e3o \u00e9 conte\u00fado para crian\u00e7as",
    "n\u00e3o foi feito para crian\u00e7as",
  ],
  youtubePublic: ["public", "\u00f6ffentlich", "publico", "p\u00fablico"],
  youtubePublish: ["publish", "ver\u00f6ffentlichen", "publicar"],
  youtubeSave: ["save", "speichern", "salvar"],
  youtubeError: [
    "not published",
    "nicht ver\u00f6ffentlicht",
    "erro",
    "falhou",
    "n\u00e3o publicado",
    "n\u00e3o foi publicado",
    "n\u00e3o foi poss\u00edvel",
    "tente novamente",
  ],
  youtubeHistoricalPublish: [
    "published previously",
    "previously published",
    "bereits ver\u00f6ffentlicht",
    "publicado anteriormente",
    "j\u00e1 publicado",
  ],
  youtubePublished: [
    "video published",
    "video has been published",
    "your video has been published",
    "video ver\u00f6ffentlicht",
    "video wurde ver\u00f6ffentlicht",
    "video publicado",
    "v\u00eddeo publicado",
    "seu video foi publicado",
    "seu v\u00eddeo foi publicado",
  ],

  tiktokSearchSounds: ["Search sounds", "Sounds suchen"],
  tiktokEdit: ["edit", "bearbeiten"],
  tiktokSounds: ["sound", "sounds", "audio"],
  tiktokText: ["text"],
  tiktokSave: ["Save", "Speichern"],
  tiktokCancel: ["Cancel", "Abbrechen"],
  tiktokShortContentCheck: ["short content check", "kurze inhaltsprufung", "kurze inhaltspr\u00fcfung"],
  tiktokEnable: ["enable", "turn on", "allow", "ok", "einschalten", "aktivieren"],
  tiktokContinue: ["got it", "continue", "verstanden", "weiter", "fortfahren"],
  tiktokLater: ["later", "not now", "skip", "spater", "spaeter", "sp\u00e4ter"],
  tiktokClose: ["cancel", "close", "abbrechen", "schliessen", "schlie\u00dfen"],
  tiktokPublish: ["publish", "post", "ver\u00f6ffentlichen", "veroeffentlichen", "publicar", "publier", "pubblica"],
  tiktokPublished: [
    "published",
    "posted",
    "success",
    "scheduled",
    "ver\u00f6ffentlicht",
    "veroeffentlicht",
    "erfolgreich",
    "geplant",
    "zur prufung eingereicht",
    "zur pr\u00fcfung eingereicht",
  ],
  tiktokFailed: [
    "failed",
    "error",
    "could not",
    "retry",
    "nicht moglich",
    "nicht m\u00f6glich",
    "fehlgeschlagen",
    "erneut versuchen",
  ],
  tiktokConfirm: [
    "publish",
    "post",
    "confirm",
    "continue",
    "ver\u00f6ffentlichen",
    "veroeffentlichen",
    "best\u00e4tigen",
    "bestaetigen",
    "fortfahren",
  ],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function terms(...keys) {
  return keys.flatMap((key) => LABELS[key] || []);
}

function pattern(...keys) {
  const values = terms(...keys);
  if (values.length === 0) {
    throw new Error(`No platform UI labels configured for: ${keys.join(", ")}`);
  }
  return new RegExp(values.map(escapeRegExp).join("|"), "i");
}

function textSelector(selector, ...keys) {
  return terms(...keys)
    .map((value) => `${selector}:has-text("${value.replace(/"/g, '\\"')}")`)
    .join(", ");
}

function attrSelector(selector, attr, ...keys) {
  return terms(...keys)
    .map((value) => `${selector}[${attr}*="${value.replace(/"/g, '\\"')}" i]`)
    .join(", ");
}

module.exports = {
  attrSelector,
  pattern,
  terms,
  textSelector,
};
