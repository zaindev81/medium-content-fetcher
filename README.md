# Medium Recommended Articles Scraper

This tool scrapes **Medium's recommended articles** for one or more tags, extracts useful metadata (title, claps, comments, URL, etc.), and saves the data in a structured JSON format. It supports filtering, deduplication, and incremental updates for ongoing collection.

## Requirements

* Node.js v18+ (uses `node:fs/promises`)
* [Puppeteer](https://pptr.dev/)

Install dependencies:

```bash
npm install
```

---

## Usage

### Basic Command

```bash
node index.mjs <tag1,tag2,tag3> [options]
```

Example:

```bash
node index.mjs programming,technology
```

---

### Command-Line Options

| Option              | Description                                                                 | Default                                                          |        |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| `<tag1,tag2>`       | Comma-separated list of Medium tags to scrape.                              | **Required**                                                     |        |
| `--scrolls N`       | Number of times to auto-scroll the page to load more articles.              | `6`                                                              |        |
| `--minClaps N`      | Minimum number of claps (likes) an article must have to be included.        | `0`                                                              |        |
| `--limit N`         | Maximum number of articles to keep **per tag** after filtering and sorting. | `30`                                                             |        |
| `--include kw1,kw2` | Only include articles whose titles contain **any** of these keywords.       | none                                                             |        |
| `--exclude kw1,kw2` | Exclude articles whose titles contain **any** of these keywords.            | none                                                             |        |
| `--headless true`   | false                                                                     | Run Puppeteer in headless mode (set `false` to see the browser). | `true` |

---

### Example Commands

**Scrape two tags with filters:**

```bash
node index.mjs programming,ai --minClaps 100 --limit 50
```

> Fetch articles for `programming` and `ai` tags, only include articles with **100+ claps**, keep **top 50** articles.

---

**Include and exclude keywords:**

```bash
node index.mjs blockchain,web3 --include ethereum,defi --exclude scam,hack
```

> Scrape `blockchain` and `web3` tags, **only include titles containing `ethereum` or `defi`**, and **exclude titles containing `scam` or `hack`**.

---

**Debug mode (non-headless):**

```bash
node index.mjs startups --headless false
```

> Opens the browser window so you can see what Puppeteer is doing.

---

## Output

The script creates a directory:

```
./medium_recommended/
```

Each month, a new file is created with the format:

```
medium-articles-YYYY-MM.json
```

Example: `medium-articles-2025-09.json`

### JSON Structure

```json
{
  "programming": [
    {
      "url": "https://medium.com/p/abc123",
      "title": "How to Build a Digital Clock Using ESP32",
      "createdAt": "2025-09-08T07:53:00.000Z",
      "claps": 250,
      "comments": 10,
      "tag": "programming"
    }
  ],
  "ai": [
    {
      "url": "https://medium.com/p/xyz456",
      "title": "Proximal SFT: SFT Supercharged By RL Is Here",
      "createdAt": "2025-09-08T07:55:00.000Z",
      "claps": 1500,
      "comments": 25,
      "tag": "ai"
    }
  ]
}
```