const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.catalog",
    version: "1.2.0",
    name: "AniDark",
    description: "The ultimate anime hub. English titles, fixed metadata, seasonal charts, and movies.",
    resources: ["catalog", "meta"], // A GRANDE MUDANÇA: Agora fornecemos os detalhes!
    types: ["anime"],
    idPrefixes: ["kitsu:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "Trending This Week" },
        { type: "anime", id: "anidark_current", name: "Current Season (Spring 2026)" },
        { type: "anime", id: "anidark_movies", name: "Trending Anime Movies" }, // Alterado para 'anime'
        { 
            type: "anime", 
            id: "anidark_past", 
            name: "Past Seasons", 
            extra: [{ name: "genre", isRequired: true, options: ["Winter 2026", "Fall 2025", "Summer 2025", "Spring 2025", "Winter 2025", "Fall 2024"] }] 
        },
        { 
            type: "anime", 
            id: "anidark_genres", 
            name: "Discover by Genre", 
            extra: [{ name: "genre", isRequired: true, options: ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Isekai", "Mecha", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller", "Others"] }] 
        }
    ]
};

const builder = new addonBuilder(manifest);

// 1. LÓGICA DO CATÁLOGO (A Grelha Multiview)
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    let url = "https://kitsu.io/api/edge/anime";
    let params = "?limit=20";
    
    if (id === "anidark_trending") {
        url = "https://kitsu.io/api/edge/trending/anime";
    } else if (id === "anidark_current") {
        params += "&filter[season]=spring&filter[seasonYear]=2026&sort=-userCount";
    } else if (id === "anidark_movies") {
        params += "&filter[subtype]=movie&sort=-userCount"; // Filtro correto para filmes
    } else if (id === "anidark_past" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        params += `&filter[season]=${season}&filter[seasonYear]=${year}&sort=-userCount`;
    } else if (id === "anidark_genres" && extra.genre) {
        if (extra.genre !== "Others") {
            params += `&filter[categories]=${extra.genre}&sort=-userCount`;
        } else {
            params += "&sort=-createdAt";
        }
    }

    try {
        const response = await axios.get(`${url}${params}`, { timeout: 6000 });
        const metas = response.data.data.map(anime => {
            const attrs = anime.attributes;
            let title = attrs.titles.en || attrs.titles.en_us || attrs.titles.en_jp || attrs.canonicalTitle;
            
            return {
                id: `kitsu:${anime.id}`,
                type: "anime",
                name: title,
                poster: attrs.posterImage ? attrs.posterImage.large : "",
            };
        });
        return { metas };
    } catch (erro) {
        console.error("Erro no Catálogo:", erro.message);
        return { metas: [] };
    }
});

// 2. LÓGICA DOS METADADOS (O Ecrã de Detalhes / Program)
builder.defineMetaHandler(async ({ type, id }) => {
    // Extrai apenas o número do ID (ex: "kitsu:1234" -> "1234")
    const kitsuId = id.split(":")[1]; 
    
    try {
        const response = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 6000 });
        const attrs = response.data.data.attributes;
        
        // Força bruta no Inglês
        let title = attrs.titles.en || attrs.titles.en_us || attrs.titles.en_jp || attrs.canonicalTitle;

        return {
            meta: {
                id: id,
                type: "anime",
                name: title,
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
