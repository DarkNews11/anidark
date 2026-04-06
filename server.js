const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.catalog",
    version: "1.3.0",
    name: "AniDark",
    description: "Anime & Movies Hub. Smart titles, seasonal charts, and dedicated movie filters.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["kitsu:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "Trending Anime" },
        { type: "anime", id: "anidark_current", name: "Current Season (Spring 2026)" },
        { 
            type: "anime", 
            id: "anidark_past", 
            name: "Anime by Season", 
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }] 
        },
        { 
            type: "anime", 
            id: "anidark_genres", 
            name: "Anime by Genre", 
            extra: [{ name: "genre", isRequired: true, options: ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Isekai", "Mecha", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller", "Others"] }] 
        },
        // --- SECÇÃO EXCLUSIVA DE FILMES ---
        { type: "anime", id: "anidark_movies_trend", name: "Trending Movies" },
        { 
            type: "anime", 
            id: "anidark_movies_season", 
            name: "Movies by Season", 
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }] 
        }
    ]
};

const builder = new addonBuilder(manifest);

// Função para filtrar os títulos de forma inteligente (Evita o erro "Kyoushit")
function getBestTitle(titles, canonical) {
    if (!titles) return canonical || "Unknown Title";
    return titles.en || titles.en_us || titles.en_jp || titles.ja_jp || canonical;
}

// 1. LÓGICA DO CATÁLOGO
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    let url = "https://kitsu.io/api/edge/anime";
    let params = "?limit=20";
    
    if (id === "anidark_trending") {
        url = "https://kitsu.io/api/edge/trending/anime";
    } else if (id === "anidark_current") {
        params += "&filter[season]=spring&filter[seasonYear]=2026&sort=-userCount";
    } else if (id === "anidark_past" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        params += `&filter[season]=${season}&filter[seasonYear]=${year}&sort=-userCount`;
    } else if (id === "anidark_genres" && extra.genre) {
        if (extra.genre !== "Others") {
            params += `&filter[categories]=${extra.genre}&sort=-userCount`;
        } else {
            params += "&sort=-createdAt";
        }
    } else if (id === "anidark_movies_trend") {
        params += "&filter[subtype]=movie&sort=-userCount";
    } else if (id === "anidark_movies_season" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        params += `&filter[subtype]=movie&filter[season]=${season}&filter[seasonYear]=${year}&sort=-userCount`;
    }

    try {
        const response = await axios.get(`${url}${params}`, { timeout: 6000 });
        const metas = response.data.data.map(anime => {
            const attrs = anime.attributes;
            return {
                id: `kitsu:${anime.id}`,
                type: "anime",
                name: getBestTitle(attrs.titles, attrs.canonicalTitle),
                poster: attrs.posterImage ? attrs.posterImage.large : "",
            };
        });
        return { metas };
    } catch (erro) {
        console.error("Erro no Catálogo:", erro.message);
        return { metas: [] };
    }
});

// 2. LÓGICA DOS METADADOS (O Ecrã de Detalhes)
builder.defineMetaHandler(async ({ type, id }) => {
    const kitsuId = id.split(":")[1]; 
    
    try {
        const response = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 6000 });
        const attrs = response.data.data.attributes;

        return {
            meta: {
                id: id,
                type: "anime",
                name: getBestTitle(attrs.titles, attrs.canonicalTitle),
                description: attrs.synopsis,
                poster: attrs.posterImage ? attrs.posterImage.large : "",
                background: attrs.coverImage ? attrs.coverImage.original : (attrs.posterImage ? attrs.posterImage.original : ""),
                genres: attrs.subtype ? [attrs.subtype] : [],
                releaseInfo: attrs.startDate ? attrs.startDate.split("-")[0] : ""
            }
        };
    } catch (erro) {
        console.error("Erro nos Metadados:", erro.message);
        return { meta: {} };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
