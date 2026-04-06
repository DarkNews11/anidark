const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.mal",
    version: "2.1.0",
    name: "AniDark",
    description: "Powered by MyAnimeList. Impeccable metadata and cached catalogs for TV stability.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["mal:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "Trending Anime" },
        { type: "anime", id: "anidark_current", name: "Current Season (Spring 2026)" },
        { type: "anime", id: "anidark_movies_trend", name: "Trending Movies" },
        { type: "anime", id: "anidark_movies_current", name: "Movies (Spring 2026)" }, 
        {
            type: "anime",
            id: "anidark_past",
            name: "Anime by Season",
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }]
        }
    ]
};

const builder = new addonBuilder(manifest);
const jikanApi = axios.create({ baseURL: "https://api.jikan.moe/v4" });

// SISTEMA DE CACHE: Guarda os dados para não sobrecarregar a API
const cache = {};
const CACHE_TTL = 2 * 60 * 60 * 1000; // Guarda os dados por 2 horas

async function fetchWithCache(endpoint) {
    // Se já estiver na memória, devolve instantaneamente
    if (cache[endpoint] && (Date.now() - cache[endpoint].timestamp < CACHE_TTL)) {
        return cache[endpoint].data;
    }
    
    // Pequeno atraso aleatório para o Stremio não rebentar com o limite do Jikan
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1200));
    
    try {
        const response = await jikanApi.get(endpoint, { timeout: 8000 });
        cache[endpoint] = { timestamp: Date.now(), data: response.data.data };
        return response.data.data;
    } catch (error) {
        console.error(`Erro na API Jikan (${endpoint}):`, error.message);
        return null;
    }
}

// Funções seguras para extrair Imagens e Títulos (evita ecrãs pretos)
function getSafeImage(anime) {
    if (!anime || !anime.images) return "";
    return anime.images.webp?.large_image_url || anime.images.jpg?.large_image_url || "";
}

function getSafeTitle(anime) {
    if (!anime) return "Unknown Title";
    return anime.title_english || anime.title || "Unknown Title";
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    let endpoint = "";
    let isMovieCurrentSeason = false;

    if (id === "anidark_trending") endpoint = "/top/anime?filter=airing&limit=20";
    else if (id === "anidark_current") endpoint = "/seasons/now?limit=20";
    else if (id === "anidark_movies_trend") endpoint = "/top/anime?type=movie&limit=20";
    else if (id === "anidark_movies_current") {
        endpoint = "/seasons/now?limit=25"; 
        isMovieCurrentSeason = true;
    }
    else if (id === "anidark_past" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        endpoint = `/seasons/${year}/${season}?limit=20`;
    }

    const rawData = await fetchWithCache(endpoint);
    if (!rawData) return { metas: [] };

    let animes = rawData;
    if (isMovieCurrentSeason) {
        animes = animes.filter(a => a.type === "Movie");
    }

    const metas = animes.map(anime => ({
        id: `mal:${anime.mal_id}`,
        type: "anime",
        name: getSafeTitle(anime),
        poster: getSafeImage(anime),
    }));

    return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
    const malId = id.split(":")[1];
    const anime = await fetchWithCache(`/anime/${malId}`);
    
    if (!anime) return { meta: {} };

    // Tenta ir buscar o fundo em alta resolução ao thumbnail do YouTube, senão usa o poster
    let backgroundUrl = getSafeImage(anime);
    if (anime.trailer && anime.trailer.images && anime.trailer.images.maximum_image_url) {
        backgroundUrl = anime.trailer.images.maximum_image_url;
    }

    return {
        meta: {
            id: id,
            type: "anime",
            name: getSafeTitle(anime),
            description: anime.synopsis || "Sinopse não disponível.",
            poster: getSafeImage(anime),
            background: backgroundUrl,
            genres: anime.genres ? anime.genres.map(g => g.name) : [],
            releaseInfo: anime.year ? anime.year.toString() : ""
        }
    };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
