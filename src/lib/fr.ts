// French for every text of the page and the server's messages, keyed by the English.
export const FR: Record<string, string> = {
  "Loading…": "Chargement…",
  Password: "Mot de passe",
  "Sign in": "Se connecter",
  "Sign out": "Se déconnecter",
  "Sign in first.": "Connectez-vous d’abord.",
  "GitHub is connected.": "GitHub est connecté.",
  "Your apps live in your own GitHub. Connect GitHub creates a small GitHub App in your account: click Create, then Install. Its key stays in this builder.":
    "Vos apps vivent dans votre propre GitHub. « Connecter GitHub » crée une petite GitHub App dans votre compte : cliquez sur Create, puis sur Install. Sa clé reste dans ce builder.",
  "Connect GitHub": "Connecter GitHub",
  "The GitHub App {app} is created. Install it on your account, with access to all repositories, so new apps are reachable.":
    "La GitHub App {app} est créée. Installez-la sur votre compte, avec accès à tous les dépôts, pour que les nouvelles apps soient accessibles.",
  "Install it": "L’installer",
  "Connected through {app}.": "Connecté via {app}.",
  "Manage on GitHub": "Gérer sur GitHub",
  "Your apps": "Vos apps",
  "Live app": "App en ligne",
  Open: "Ouvrir",
  "No apps yet.": "Pas encore d’app.",
  "New app": "Nouvelle app",
  "Deploy to Cloudflare copies the app template into your GitHub, creates its database and puts it online. Pick a name for it there.":
    "« Deploy to Cloudflare » copie le modèle d’app dans votre GitHub, crée sa base de données et la met en ligne. Choisissez-lui un nom à cette étape.",
  "Deploy a new app": "Déployer une nouvelle app",
  "Once Cloudflare shows it online, add it here.": "Une fois en ligne chez Cloudflare, ajoutez-la ici.",
  "Find my new app": "Trouver ma nouvelle app",
  "No new app found yet. If the deploy finished, check the GitHub App can reach all your repositories.":
    "Aucune nouvelle app trouvée. Si le déploiement est terminé, vérifiez que la GitHub App a accès à tous vos dépôts.",
  Add: "Ajouter",
  "Build with Claude": "Construire avec Claude",
  "In Claude: Settings → Connectors → Add custom connector, then paste this address. Claude asks you to allow it here once.":
    "Dans Claude : Paramètres → Connecteurs → Ajouter un connecteur personnalisé, puis collez cette adresse. Claude vous demande une fois de l’autoriser ici.",
  "To update: on GitHub, your builder's repo → Actions → Update Dozokit Apps → Run workflow.":
    "Pour mettre à jour : sur GitHub, le dépôt de votre builder → Actions → Update Dozokit Apps → Run workflow.",
  "Saved. Cloudflare is building it; the live app updates in about a minute.":
    "Enregistré. Cloudflare le construit ; l’app en ligne se met à jour dans une minute environ.",
  "This app has changes that aren't saved. They stay in the draft, but they aren't live. Leave anyway?":
    "Cette app a des changements non enregistrés. Ils restent dans le brouillon, mais ne sont pas en ligne. Quitter quand même ?",
  "Reload preview": "Recharger l’aperçu",
  "Saving…": "Enregistrement…",
  Save: "Enregistrer",
  "{n} unsaved changes in the draft:": "{n} changement(s) non enregistré(s) dans le brouillon :",
  "Everything in the draft is live.": "Tout le brouillon est en ligne.",
  "Draft preview": "Aperçu du brouillon",
  "No draft preview address yet: set it below.": "Pas encore d’adresse d’aperçu : indiquez-la ci-dessous.",
  "Draft preview address": "Adresse de l’aperçu",
  "Live address": "Adresse en ligne",
  "Save addresses": "Enregistrer les adresses",
  "Draft preview: {url}": "Aperçu du brouillon : {url}",
  Change: "Modifier",
  "Local mode: the app is a git repo on this computer, made from the local template, and runs here.": "Mode local : l’app est un dépôt git sur cet ordinateur, créé depuis le modèle local, et tourne ici.",
  "Name (lowercase, e.g. bookings)": "Nom (minuscules, ex. rendez-vous)",
  "Creating…": "Création…",
  Create: "Créer",
  // From the server
  "That password is not the one set for this builder.": "Ce n’est pas le mot de passe de ce builder.",
  "Too many attempts. Wait a minute, then try again.": "Trop d’essais. Attendez une minute, puis réessayez.",
  "This builder needs a password of 12 characters or more before it opens.": "Ce builder a besoin d’un mot de passe de 12 caractères ou plus avant de s’ouvrir.",
  "Nothing to save: the draft has no changes that aren't live already.": "Rien à enregistrer : le brouillon n’a aucun changement qui ne soit déjà en ligne.",
  "Not saved. The safety check failed:\n{errors}": "Non enregistré. Le contrôle de sécurité a échoué :\n{errors}",
  "Not saved: the draft and main changed the same lines. Update the draft from main first.":
    "Non enregistré : le brouillon et main ont modifié les mêmes lignes. Mettez d’abord le brouillon à jour depuis main.",
  "GitHub isn't connected yet: the owner clicks Connect GitHub in the builder first.": "GitHub n’est pas encore connecté : cliquez d’abord sur « Connecter GitHub ».",
  "{repo} isn't an app this builder can reach: it must be made from dozokit/app-template, with main as its default branch.":
    "{repo} n’est pas une app accessible à ce builder : elle doit venir de dozokit/app-template, avec main comme branche par défaut.",
  "This GitHub answer doesn't match a Connect GitHub started here, or it's over an hour old. Click Connect GitHub again.":
    "Cette réponse de GitHub ne correspond à aucun « Connecter GitHub » lancé ici, ou elle date de plus d’une heure. Cliquez à nouveau sur « Connecter GitHub ».",
  "Connect GitHub first, then install the app it creates.": "Connectez d’abord GitHub, puis installez l’app qu’il crée.",
};
