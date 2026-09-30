import axios from 'axios';
import cheerio from 'cheerio';
import fs from 'fs';

const SOURCES = [
  { name: 'futbollibre', url: 'https://futbollibre.com' },
  { name: 'trajira-roja', url: 'https://trajiraroja.com' },
  { name: 'agenda', url: 'https://agenda.com' }
];

const BASE_URL = process.env.BASE_URL || 'https://embed.saohgdasregions.fun/';

async function scrapeChannels() {
  const channels = new Map();

  for (const source of SOURCES) {
    try {
      const { data } = await axios.get(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(data);

      $('a.stream-link, .channel-item, .channel-link').each((_, el) => {
        const $el = $(el);
        const name = $el.find('h3, h4, .channel-name').first().text().trim();
        const relativeUrl = $el.attr('href');
        const imageUrl = $el.find('img').first().attr('src') || '';

        if (name && relativeUrl) {
          const fullUrl = relativeUrl.startsWith('http') 
            ? relativeUrl 
            : `${source.url}${relativeUrl}`;

          if (!channels.has(name)) {
            channels.set(name, {
              title: name,
              image: imageUrl,
              category: 'deportes',
              options: []
            });
          }

          const channel = channels.get(name);
          const embedUrl = `${BASE_URL}${relativeUrl.replace(/^\//, '')}`;
          
          channel.options.push({
            label: source.name,
            url: embedUrl
          });
        }
      });
    } catch (err) {
      console.error(`Error scraping ${source.name}:`, err.message);
    }
  }

  return Array.from(channels.values()).filter(ch => ch.options.length > 0);
}

async function updateData1Json(newChannels) {
  const data1Path = 'data1.json';
  let data = { canales: [] };

  try {
    const content = fs.readFileSync(data1Path, 'utf-8');
    const parsed = JSON.parse(content);
    data.canales = parsed.canales || [];
  } catch (err) {
    console.log('Creating new data1.json');
  }

  const merged = [...data.canales];
  const existingTitles = new Set(merged.map(ch => ch.title));

  for (const channel of newChannels) {
    if (existingTitles.has(channel.title)) {
      const idx = merged.findIndex(ch => ch.title === channel.title);
      merged[idx].options = [...new Set([
        ...merged[idx].options,
        ...channel.options
      ].filter((opt, i, arr) => arr.findIndex(o => o.url === opt.url) === i)])];
    } else {
      merged.push(channel);
    }
  }

  data.canales = merged;
  fs.writeFileSync(data1Path, JSON.stringify(data, null, 2));
  console.log(`Updated ${merged.length} channels`);
}

async function main() {
  console.log('Scraping channels...');
  const channels = await scrapeChannels();
  console.log(`Found ${channels.length} channels`);
  
  await updateData1Json(channels);
  
  process.exit(0);
}

main();
