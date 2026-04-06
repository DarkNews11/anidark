const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const manifest = {
    id: "org.anidark.catalog",
    version: "1.0.0",
    name: "AniDark",
    description: "The latest anime releases, seasonal charts, and genre discovery. English titles prioritized.",
    resources: ["catalog"],
    types: ["anime"],
    idPrefixes: ["kitsu:"],
    catalogs: [
        { type: "anime", id: "anidark_trending", name: "Trending This Week" },
        { type: "anime", id: "anidark_current", name: "Current Season (Spring 2026)" },
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

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    let url = "";
    
    // Lógica para encaminhar cada catálogo para a pesquisa correta
    if (id === "anidark_trending") {
        url = "https://kitsu.io/api/edge/trending/anime?limit=20";
    } else if (id === "anidark_current") {
        url = "https://kitsu.io/api/edge/anime?filter[season]=spring&filter[seasonYear]=2026&sort=-userCount&limit=20";
    } else if (id === "anidark_past" && extra.genre) {
        const [season, year] = extra.genre.toLowerCase().split(" ");
        url = `https://kitsu.io/api/edge/anime?filter[season]=${season}&filter[seasonYear]=${year}&sort=-userCount&limit=20`;
    } else if (id === "anidark_genres" && extra.genre) {
        if (extra.genre === "Others") {
            url = "https://kitsu.io/api/edge/anime?sort=-createdAt&limit=20"; // Animes recentes gerais
        } else {
            url = `https://kitsu.io/api/edge/anime?filter[categories]=${extra.genre}&sort=-userCount&limit=20`;
        }
    } else {
        return { metas: [] };
    }

    try {
        const { data } = await axios.get(url);
        
        const metas = data.data.map(anime => {
            const attrs = anime.attributes;
            const tituloFinal = attrs.titles.en || attrs.titles.en_jp || attrs.canonicalTitle;
            
            return {
                id: `kitsu:${anime.id}`,
                type: "anime",
                name: tituloFinal,
                poster: attrs.posterImage ? attrs.posterImage.large : "",
                description: attrs.synopsis,
                genres: attrs.subtype ? [attrs.subtype] : []
            };
        });
        
        return { metas };
    } catch (erro) {
        console.error("Erro a contactar o Kitsu:", erro);
        return { metas: [] };
    }
});

// A porta 'process.env.PORT' é essencial para alojamentos na cloud
serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
