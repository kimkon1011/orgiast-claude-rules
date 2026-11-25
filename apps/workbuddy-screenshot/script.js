/**
 * apps/workbuddy-screenshot/script.js
 * WorkBuddy + Hy4 生成サンプル — オージャスト展示会ブースLP
 */

// ─── Works Data ────────────────────────────────────────

const worksData = [
  { title: 'テクノロジー展示会ブース', cat: 'exhibition', color: '#1a3a5c' },
  { title: '食品展示会ブース設計', cat: 'exhibition', color: '#2a5a8a' },
  { title: '自動車部品展示会', cat: 'exhibition', color: '#3a6a8a' },
  { title: '新商品発表イベント', cat: 'event', color: '#4a7a8a' },
  { title: '株主総会展示', cat: 'event', color: '#1a4a6c' },
  { title: '周年記念イベントブース', cat: 'event', color: '#2a5a7c' },
  { title: 'ショールーム設計', cat: 'other', color: '#3a6a7c' },
  { title: 'ポップアップストア', cat: 'other', color: '#4a7a7c' },
  { title: 'オフィス内展示コーナー', cat: 'other', color: '#1a4a5c' },
];

// ─── Header scroll e[ect ──────────────────────────────

const header = document.getElementById('header');

window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 20);
});

// ─── Hamburger menu ────────────────────────────────────

const hamburger = document.querySelector('.header__hamburger');
const nav = document.querySelector('.header__nav');

hamburger.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('open');
  hamburger.setAttribute('aria-expanded', isOpen);
  hamburger.setAttribute('aria-label', isOpen ? 'メニューを閉じる' : 'メニューを開く');
});

// ナビゲーションリンククリックでメニューを閉じる
document.querySelectorAll('.header__nav-link').forEach(link => {
  link.addEventListener('click', () => {
    nav.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.setAttribute('aria-label', 'メニューを開く');
  });
});

// ─── Works Gallery ─────────────────────────────────────

const worksGrid = document.getElementById('worksGrid');
const filterBtns = document.querySelectorAll('.works__filter');

function renderWorks(filter = 'all') {
  const items = filter === 'all'
    ? worksData
    : worksData.filter(w => w.cat === filter);

  worksGrid.innerHTML = items.map((work, i) => `
    <article class="works__card" data-index="${i}" tabindex="0" role="button"
      aria-label="${work.title}" style="background:${work.color}">
      <!-- プレースホルダーグラデーション -->
      <div class="works__card-img"
        style="background: linear-gradient(135deg, ${work.color}, ${lighten(work.color, 30)});">
      </div>
      <div class="works__card-overlay">
        <span class="works__card-title">${work.title}</span>
        <span class="works__card-cat">${catLabel(work.cat)}</span>
      </div>
    </article>
  `).join('');

  // Lightbox click handler
  document.querySelectorAll('.works__card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.index);
      showLightbox(worksData[idx]);
    });
  });
}

function catLabel(cat) {
  const labels = { exhibition: '展示会', event: 'イベント', other: 'その他' };
  return labels[cat] || cat;
}

function lighten(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (num >> 16) + percent);
  const g = Math.min(255, ((num >> 8) & 0xFF) + percent);
  const b = Math.min(255, (num & 0xFF) + percent);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ─── Lightbox ────────────────────────────────────────────

let lightboxEl = null;

function showLightbox(work) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.addEventListener('click', (e) => {
      if (e.target === lightboxEl) closeLightbox();
    });
    document.body.appendChild(lightboxEl);
  }
  lightboxEl.innerHTML = `
    <div class="lightbox__content">
      <button class="lightbox__close" aria-label="閉じる">&times;</button>
      <div style="width:200px;height:150px;background:linear-gradient(135deg,${work.color},${lighten(work.color,40)});border-radius:4px;margin:0 auto 16px;"></div>
      <h3 style="font-size:20px;font-weight:700;margin-bottom:8px;color:var(--color-primary)">${work.title}</h3>
      <p style="font-size:14px;color:var(--color-text-light)">カテゴリ: ${catLabel(work.cat)}</p>
      <p style="font-size:14px;color:var(--color-text-light);margin-top:8px;">施工期間: 約3週間 / 規模: 小間〜中ブース</p>
    </div>
  `;
  lightboxEl.querySelector('.lightbox__close').addEventListener('click', closeLightbox);
  lightboxEl.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  if (lightboxEl) {
    lightboxEl.classList.remove('active');
    document.body.style.overflow = '';
  }
}

// Close with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// ─── Filter tabs ───────────────────────────────────────

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    renderWorks(btn.dataset.filter);
  });
});

// ─── Counter animation ─────────────────────────────────

function animateCounters() {
  const counters = document.querySelectorAll('.about__stat-number');
  counters.forEach(counter => {
    const target = parseInt(counter.dataset.target);
    const duration = 1500;
    const start = performance.now();

    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3);
      counter.textContent = Math.floor(target * eased);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  });
}

// Intersection Observer for counter trigger
const aboutSection = document.getElementById('about');
let countersAnimated = false;

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting && !countersAnimated) {
      countersAnimated = true;
      animateCounters();
    }
  });
}, { threshold: 0.3 });

if (aboutSection) observer.observe(aboutSection);

// ─── Init ────────────────────────────────────────────────

renderWorks('all');