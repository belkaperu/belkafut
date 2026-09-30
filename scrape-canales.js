const axios = require('axios');
const fs = require('fs');
const cheerio = require('cheerio');

async function scrapeChannels() {
  const sources = [
    { name: 'futbollibre', url: 'https://futbollibre.com/canales' },
    { name: 'trajira-roja', url: 'https://trajiraroja.com/canales' }
  ];

  const channels = new Map();

  for (const source of sources) {
    try {
      console.log(`Scraping ${source.name}...`);
      const { data } = await axios.get(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(data);

      $('a.channel-link, a.stream-link, .channel-item').each((_, el) => {
        const $el = $(el);
        const name = $el.find('h3, h4, .channel-name').text().trim();
        const imageUrl = $el.find('img').attr('src') || '';
        const url = $el.attr('href') || '';

        if (name && url) {
          if (!channels.has(name)) {
            channels.set(name, {
              title: name,
              image: imageUrl,
              category: 'deportes',
              options: []
            });
          }
          channels.get(name).options.push({
            label: source.name,
            url: url
          });
        }
      });
    } catch (err) {
      console.error(`Error scraping ${source.name}:`, err.message);
    }
  }

  const data1Json = Array.from(channels.values())
    .filter(ch => ch.options.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title));

  fs.writeFileSync('data1.json', JSON.stringify(data1Json, null, 2));
  console.log(`✅ Saved ${data1Json.length} channels to data1.json`);
}

scrapeChannels();
