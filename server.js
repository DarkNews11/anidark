const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.mal",
    version: "2.0.0",
    name: "AniDark",
    description: "Powered by MyAnimeList. Impeccable metadata and dedicated movie sections.",
    resources: ["catalog", "meta"],
    types: ["anime"],
    idPrefixes: ["mal:"], // O prefixo mudou para o MyAnimeList
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "Trending Anime" },
        { type: "anime", id: "anidark_current", name: "Current Season (Spring 2026)" },
        { type: "anime", id: "anidark_movies_trend", name: "Trending Movies" },
        // Esta categoria sem "extra" é o que a faz aparecer na página principal
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

// Cliente preparado para a API v4 do Jikan
const jikanApi = axios.create({ baseURL: "https://api.jikan.moe/v4" });

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    let endpoint = "";
    let isMovieCurrentSeason = false;

    if (id === "anidark_trending") endpoint = "/top/anime?filter=airing&limit=20";
    else if (id === "anidark_current") endpoint = "/seasons/now?limit=20";
    else if (id === "anidark_movies_trend") endpoint = "/top/anime?type=movie&limit=20";
    else if (id === "anidark_movies_current") {
        endpoint = "/seasons/now?limit=25"; 
        isMovieCurrentSeason = true; // Flag para filtrarmos filmes do que está a dar agora
    }
    else if (id === "anidark_past" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        endpoint = `/seasons/${year}/${season}?limit=20`;
    }

    try {
        const response = await jikanApi.get(endpoint);
        let rawData = response.data.data;

        // Se for o separador de filmes da época, escondemos as séries
        if (isMovieCurrentSeason) {
            rawData = rawData.filter(anime => anime.type === "Movie");
        }

        const metas = rawData.map(anime => {
            return {
                id: `mal:${anime.mal_id}`,
                type: "anime",
                name: anime.title_english || anime.title,
                poster: anime.images.jpg.large_image_url || "",
            };
        });
        return { metas };
    } catch (erro) {
        console.error("Erro no Jikan (Catálogo):", erro.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    const malId = id.split(":")[1];

    try {
        const response = await jikanApi.get(`/anime/${malId}`);
        const anime = response.data.data;

        return {
            meta: {
                id: id,
                type: "anime",
                name: anime.title_english || anime.title,
                description: anime.synopsis,
                poster: anime.images.jpg.large_image_url || "",
                // O Jikan tem as thumbnails dos trailers oficiais, ótimas para background
                background: anime.trailer?.images?.maximum_image_url || anime.images.jpg.large_image_url || "",
                genres: anime.genres ? anime.genres.map(g => g.name) : [],
                releaseInfo: anime.year ? anime.year.toString() : ""
            }
        };
    } catch (erro) {
        console.error("Erro no Jikan (Metadados):", erro.message);
        return { meta: {} };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
