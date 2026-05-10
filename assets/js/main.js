/**
 * BNI メンバー紹介ページ — メインロジック
 * ========================================
 * 【最初にやること】
 * 1. 下の CONFIG.webAppUrl に、GAS を「ウェブアプリ」としてデプロイした URL を貼る
 * 2. スプレッドシートの1行目を「ヘッダー行」にし、GAS 側の HEADER_ROW と一致させる
 *
 * 【あとから列を追加したいとき】
 * - スプレッドシートに列を追加
 * - GAS の HEADER_ROW にキー（英語の列名）を追加
 * - このファイルの MEMBER_FIELDS にフィールドを1行追加
 * - index.html のカード用マークアップは buildMemberCard() 内を編集
 */

// ---------------------------------------------------------------------------
// 設定（ここだけ編集すれば動かせる想定）
// ---------------------------------------------------------------------------
const CONFIG = {
  /**
   * Google Apps Script のウェブアプリ URL（末尾 /exec）
   * 例: "https://script.google.com/macros/s/xxxx/exec"
   */
  webAppUrl:
    "https://script.google.com/macros/s/AKfycbxfoGrPPA7c7cfoeuKvVSi8OBSHAZy8fyo3fPKwXZJMR8HmpuG4-EZWXbKJj6gobJQmJg/exec",

  /**
   * 写真が空のときに使う画像（任意のURLに差し替え可）
   * SVGのデータURLなので外部通信なしで表示できます
   */
  defaultPhotoUrl:
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
        <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#1a222d"/><stop offset="100%" style="stop-color:#232d3a"/>
        </linearGradient></defs>
        <rect width="400" height="300" fill="url(#g)"/>
        <circle cx="200" cy="115" r="36" fill="none" stroke="#d4af37" stroke-width="2" opacity="0.6"/>
        <path d="M140 210 Q200 165 260 210" fill="none" stroke="#d4af37" stroke-width="2" opacity="0.45"/>
        <text x="200" y="255" text-anchor="middle" fill="#9aa5b5" font-family="sans-serif" font-size="14">No Photo</text>
      </svg>`,
    ),

  /** fetch のタイムアウト（ミリ秒） */
  fetchTimeoutMs: 20000,
};

/**
 * メンバー1人分のフィールド定義
 * key: GAS が返す JSON のプロパティ名（スプレッドシートのヘッダーと対応）
 * label: 画面表示用ラベル（紹介してほしい人など長文用）
 */
const MEMBER_FIELDS = {
  name: { key: "name", label: "名前" },
  furigana: { key: "furigana", label: "フリガナ" },
  company: { key: "company", label: "会社名" },
  category: { key: "category", label: "カテゴリー" },
  tagline: { key: "tagline", label: "一言紹介" },
  referral: { key: "referral", label: "紹介してほしい人" },
  photoUrl: { key: "photoUrl", label: "写真URL" },
  instagram: { key: "instagram", label: "Instagram" },
  line: { key: "line", label: "LINE" },
  website: { key: "website", label: "ホームページURL" },
};

// DOM
const statusEl = document.getElementById("status");
const statusMessageEl = document.getElementById("statusMessage");
const toolbarEl = document.getElementById("toolbar");
const membersSectionEl = document.getElementById("membersSection");
const memberGridEl = document.getElementById("memberGrid");
const categoryFilterEl = document.getElementById("categoryFilter");
const searchInputEl = document.getElementById("searchInput");
const resultCountEl = document.getElementById("resultCount");

/** @type {Array<Record<string, string>>} */
let allMembers = [];

function showStatus(message, isError = false) {
  statusEl.hidden = false;
  statusMessageEl.textContent = message;
  statusEl.classList.toggle("status--error", isError);
}

function hideStatus() {
  statusEl.hidden = true;
}

/**
 * 文字列を安全にトリム（null 対策）
 * @param {unknown} v
 */
function str(v) {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * 表示用に URL を正規化（// で始まる場合は https: を付与）
 * @param {string} url
 */
function normalizeUrl(url) {
  const u = str(url);
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (/^https?:\/\//i.test(u)) return u;
  return "https://" + u;
}

/**
 * Instagram は @handle だけの場合もあるのでリンク用に変換
 * @param {string} raw
 */
function instagramHref(raw) {
  const s = str(raw);
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || s.startsWith("//")) return normalizeUrl(s);
  const handle = s.replace(/^@/, "");
  if (!handle) return "";
  return "https://www.instagram.com/" + encodeURIComponent(handle) + "/";
}

/**
 * LINE は「友だち追加」などの完全URL推奨。IDのみのときは line.me のパスを組み立てます。
 * @param {string} raw
 */
function lineHref(raw) {
  const s = str(raw);
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || s.startsWith("//")) return normalizeUrl(s);
  const id = s.replace(/^@/, "");
  if (!id) return "";
  const pathId = id.startsWith("@") ? id : "@" + id;
  return "https://line.me/R/ti/p/" + pathId;
}

/**
 * メンバーオブジェクトから検索用文字列を生成
 * @param {Record<string, string>} m
 */
function memberSearchBlob(m) {
  return Object.values(m)
    .map((v) => str(v).toLowerCase())
    .join(" ");
}

/**
 * カテゴリーのセレクトボックスを再構築
 * @param {Array<Record<string, string>>} members
 */
function populateCategories(members) {
  const set = new Set();
  members.forEach((m) => {
    const c = str(m[MEMBER_FIELDS.category.key]);
    if (c) set.add(c);
  });
  const sorted = [...set].sort((a, b) => a.localeCompare(b, "ja"));

  categoryFilterEl.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "__all__";
  optAll.textContent = "すべて";
  categoryFilterEl.appendChild(optAll);

  sorted.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    categoryFilterEl.appendChild(opt);
  });
}

/**
 * 1枚のカードの HTML を組み立て
 * @param {Record<string, string>} m
 */
function buildMemberCard(m) {
  const name = str(m[MEMBER_FIELDS.name.key]);
  const furigana = str(m[MEMBER_FIELDS.furigana.key]);
  const company = str(m[MEMBER_FIELDS.company.key]);
  const category = str(m[MEMBER_FIELDS.category.key]);
  const tagline = str(m[MEMBER_FIELDS.tagline.key]);
  const referral = str(m[MEMBER_FIELDS.referral.key]);
  const photoRaw = str(m[MEMBER_FIELDS.photoUrl.key]);
  const photo = photoRaw ? normalizeUrl(photoRaw) : CONFIG.defaultPhotoUrl;
  const ig = instagramHref(m[MEMBER_FIELDS.instagram.key]);
  const line = lineHref(m[MEMBER_FIELDS.line.key]);
  const web = normalizeUrl(str(m[MEMBER_FIELDS.website.key]));

  const li = document.createElement("li");
  li.className = "member-card";

  li.innerHTML = `
    <div class="member-card__photo-wrap">
      <img class="member-card__photo" src="" alt="" loading="lazy" width="400" height="300" />
    </div>
    <div class="member-card__body">
      <h2 class="member-card__name"></h2>
    <p class="member-card__furigana"></p>
      <p class="member-card__category"></p>
      <p class="member-card__company"></p>
      <p class="member-card__tagline"></p>
      ${
        referral
          ? `<div class="member-card__referral">
        <span class="member-card__referral-label">${escapeHtml(MEMBER_FIELDS.referral.label)}</span>
        <span class="member-card__referral-text"></span>
      </div>`
          : ""
      }
      <div class="member-card__links">
        <a class="member-card__link" data-link="instagram" target="_blank" rel="noopener noreferrer">Instagram</a>
        <a class="member-card__link" data-link="line" target="_blank" rel="noopener noreferrer">LINE</a>
        <a class="member-card__link" data-link="website" target="_blank" rel="noopener noreferrer">Web</a>
      </div>
    </div>
  `;

  const img = li.querySelector(".member-card__photo");
  img.src = photo;
  img.alt = name || "メンバー写真";

  const catEl = li.querySelector(".member-card__category");
  if (catEl) catEl.textContent = category;

  li.querySelector(".member-card__name").textContent = name || "（名前未設定）";

  const furiganaEl = li.querySelector(".member-card__furigana");

  if (furiganaEl) {
    furiganaEl.textContent = furigana;
    furiganaEl.hidden = !furigana;
  }

  li.querySelector(".member-card__company").textContent = company;

  const tagEl = li.querySelector(".member-card__tagline");
  tagEl.textContent = tagline;
  tagEl.hidden = !tagline;

  const refText = li.querySelector(".member-card__referral-text");
  if (refText) refText.textContent = referral;

  const linkIg = li.querySelector('[data-link="instagram"]');
  const linkLine = li.querySelector('[data-link="line"]');
  const linkWeb = li.querySelector('[data-link="website"]');
  const romanEl = li.querySelector(".member-card__roman");
  if (ig) linkIg.href = ig;
  else linkIg.hidden = true;

  if (line) linkLine.href = line;
  else linkLine.hidden = true;

  if (web) linkWeb.href = web;
  else linkWeb.hidden = true;
  if (romanEl) {
    romanEl.textContent = roman;
    romanEl.hidden = !roman;
  }

  img.addEventListener("error", () => {
    img.onerror = null;
    img.src = CONFIG.defaultPhotoUrl;
  });

  return li;
}

/**
 * HTML エスケープ（動的に挿入するラベル用）
 * @param {string} s
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * フィルター条件に合うメンバーだけ返す
 */
function getFilteredMembers() {
  const cat = categoryFilterEl.value;
  const q = str(searchInputEl.value).toLowerCase();

  return allMembers.filter((m) => {
    if (cat !== "__all__" && str(m[MEMBER_FIELDS.category.key]) !== cat)
      return false;
    if (!q) return true;
    return memberSearchBlob(m).includes(q);
  });
}

function renderMembers() {
  const list = getFilteredMembers();
  memberGridEl.innerHTML = "";
  list.forEach((m) => memberGridEl.appendChild(buildMemberCard(m)));
  resultCountEl.textContent = `${list.length} 名を表示（全 ${allMembers.length} 名）`;
}

/**
 * JSON を fetch（タイムアウト付き）
 */
async function fetchMembersJson() {
  const url = str(CONFIG.webAppUrl);
  if (!url || url === "YOUR_GAS_WEB_APP_URL_HERE") {
    throw new Error(
      "assets/js/main.js の CONFIG.webAppUrl に、GAS ウェブアプリの URL を設定してください。",
    );
  }

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok)
      throw new Error(
        "サーバーからの応答が異常です（HTTP " + res.status + "）",
      );
    const data = await res.json();
    clearTimeout(tid);
    if (data && data.error === true) {
      throw new Error(data.message || "サーバーでエラーが発生しました。");
    }
    return data;
  } catch (e) {
    clearTimeout(tid);
    if (e.name === "AbortError")
      throw new Error(
        "通信がタイムアウトしました。URL かネットワークを確認してください。",
      );
    throw e;
  }
}

/**
 * GAS の応答を配列に正規化
 * @param {unknown} data
 */
function normalizePayload(data) {
  if (Array.isArray(data)) return data;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray(/** @type {{members?: unknown}} */ (data).members)
  ) {
    return /** @type {{members: Array<Record<string, string>>}} */ (data)
      .members;
  }
  throw new Error(
    "JSON の形式が想定と異なります。GAS が配列または { members: [] } を返すようにしてください。",
  );
}

async function init() {
  try {
    showStatus("データを読み込み中です…", false);
    toolbarEl.hidden = true;
    membersSectionEl.hidden = true;

    const raw = await fetchMembersJson();
    const arr = normalizePayload(raw);

    allMembers = arr.map((row) => {
      const o = {};
      Object.values(MEMBER_FIELDS).forEach(({ key }) => {
        o[key] = str(row[key]);
      });
      return o;
    });

    populateCategories(allMembers);
    hideStatus();
    toolbarEl.hidden = false;
    membersSectionEl.hidden = false;
    renderMembers();
  } catch (e) {
    console.error(e);
    showStatus(e.message || "読み込みに失敗しました。", true);
    toolbarEl.hidden = true;
    membersSectionEl.hidden = true;
  }
}

categoryFilterEl.addEventListener("change", renderMembers);
searchInputEl.addEventListener("input", renderMembers);

init();
