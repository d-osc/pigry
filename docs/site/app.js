const english = {
  skip: 'Skip to content', navOverview: 'Meet Pigry', navWorkflow: 'The workflow', navFaq: 'Good questions', getPigry: 'Get Pigry',
  eyebrow: 'A LITTLE CLARITY FOR YOUR CODE', heroLine1: 'Good code.', heroLine2: 'Clear head.',
  heroDescription: 'A calmer way to work with Git. Bring your code, branches and AI together in one thoughtful desktop workspace.',
  downloadPreview: 'Download v0.3.0', viewSource: 'Explore the source', heroNote: 'Windows x64 · Your existing Git repositories, welcome.', asideNote: 'A little more room for the things you want to build.',
  previewLabel: 'MEET YOUR NEW WORKSPACE', previewHint: 'Take a little look around.', previewDisclaimer: 'Illustrative product preview · Switch views and select a commit to explore.',
  foundationGit: 'The Git you already know', foundationDesktop: 'Made for your desktop', foundationAi: 'Your AI, your choice', foundationTheme: 'A light & a dark side',
  workflowEyebrow: 'FROM THE FIRST CHANGE TO THE NEXT COMMIT', workflowTitle: 'See the big picture.<br>Care for the details.',
  workflowDescription: 'Less jumping between windows. More understanding what changed. A connected workflow that lets you move forward, naturally.',
  step1Title: 'Follow the story of your code.', step1Text: 'Trace commits, explore branches and see how every change connects, with a graph that brings your project into focus.', step1Action: 'Explore the commit graph',
  step2Title: 'Make every change intentional.', step2Text: 'Read your diffs, stage just the parts you want and commit with confidence. An editor is right there when a small fix can’t wait.', step2Action: 'Look at working changes',
  step3Title: 'Think it through, together.', step3Text: 'Give your assistant the context it needs. Connect your own AI provider or coding CLI, attach code and keep the conversation close to your work.', step3Action: 'Meet the AI workspace',
  githubTitle: 'Local work.<br>Connected thinking.', githubDescription: 'Pull requests, issues and Actions through the GitHub CLI. Branch, merge, rebase and stash tools for the work in between.', githubNote: 'Connect using your GitHub account and permissions through gh.',
  themeTitle: 'Find your kind<br>of focus.', themeDescription: 'A fresh, airy canvas or a quieter, darker space. Light and dark modes share the same thoughtful language, right down to the editor.', tryTheme: 'Try a different atmosphere',
  downloadEyebrow: 'YOUR NEXT COMMIT STARTS HERE', downloadTitle: 'A good place<br>for your next idea.', downloadDescription: 'Bring Pigry into the project you’re working on.<br>Make something good, one commit at a time.', downloadWindows: 'Download v0.3.0',
  releaseStatus: 'Latest release · Available for Windows and Linux on x64 and ARM64.', viewReleases: 'All packages & release notes',
  downloadDisclosure: 'This Windows installer is unsigned. Windows may show a warning before opening it.',
  buildSource: 'More of a build-it-yourself person?', sourceRequirements: 'You’ll need Node.js 22.18+ or 24+, Rust, Git and the Tauri prerequisites for your operating system.', copy: 'Copy', readSetup: 'Read the full setup guide',
  faqTitle: 'A little more<br>before you begin.', askGithub: 'Keep the conversation going on GitHub',
  faq1Question: 'Can I open a repository I already have?', faq1Answer: 'Absolutely. Open a local Git repository and pick up where you left off. Pigry uses the Git CLI for commits and remote operations, so your existing Git configuration and hooks can come along.',
  faq2Question: 'Is an AI subscription included?', faq2Answer: 'You connect your own AI provider or coding CLI. Model access and any usage costs depend on the service you choose. The installer does not include an AI usage allowance.',
  faq3Question: 'Where does my data live?', faq3Answer: 'Your Git repositories stay on your machine. GitHub and AI features connect to the services you choose and may send data as needed for the requests you ask them to process.',
  faq4Question: 'Which version can I download?', faq4Answer: 'Download v0.3.0 for Windows x64 using the button above. For Windows ARM64, MSI and Linux (.deb, .rpm, .AppImage) on x64 and ARM64, choose a package from the GitHub release. The Windows installer is unsigned.',
  footerTagline: 'A little more clarity in your everyday code.', backTop: 'Back to the top ↑',
};
const translations = new Map([...document.querySelectorAll('[data-i18n]')].map(element => [element, element.innerHTML]));
let language = 'th';
try { if (localStorage.getItem('pigry-site-language') === 'en') language = 'en'; } catch { /* preferences are optional */ }
const languageButton = document.querySelector('#language-toggle');
const themeButton = document.querySelector('#theme-toggle');
const menuButton = document.querySelector('#menu-toggle');
const mobileMenu = document.querySelector('#mobile-menu');
const messages = {
  th: { copied: 'คัดลอกคำสั่งแล้ว', copyFailed: 'คัดลอกไม่สำเร็จ กรุณาเลือกข้อความและคัดลอกด้วยตัวเอง', downloading: 'กำลังเริ่มดาวน์โหลด Windows v0.3.0', light: 'เปลี่ยนเป็นธีมสว่าง', dark: 'เปลี่ยนเป็นธีมมืด', openMenu: 'เปิดเมนู', closeMenu: 'ปิดเมนู' },
  en: { copied: 'Commands copied.', copyFailed: 'Please select and copy the commands manually.', downloading: 'Starting your Windows v0.3.0 download.', light: 'Switch to light theme', dark: 'Switch to dark theme', openMenu: 'Open navigation', closeMenu: 'Close navigation' },
};
function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeButton.querySelector('use').setAttribute('href', dark ? '#icon-sun' : '#icon-moon');
  themeButton.setAttribute('aria-label', messages[language][dark ? 'light' : 'dark']);
  themeButton.setAttribute('aria-pressed', String(dark));
}
function setLanguage(next) {
  language = next;
  document.documentElement.lang = language;
  for (const [element, thai] of translations) {
    element.innerHTML = language === 'en' ? (english[element.dataset.i18n] ?? thai) : thai;
  }
  languageButton.innerHTML = `${language === 'th' ? 'EN' : 'TH'} <span>↗</span>`;
  languageButton.setAttribute('aria-label', language === 'th' ? 'Switch to English' : 'เปลี่ยนเป็นภาษาไทย');
  menuButton.setAttribute('aria-label', messages[language][mobileMenu.hidden ? 'openMenu' : 'closeMenu']);
  document.querySelector('meta[name="description"]').content = language === 'en' ? english.heroDescription : 'Pigry รวม Git repository, commit graph, code editor และ AI ไว้ในพื้นที่ทำงานเดียวบนเดสก์ท็อป';
  try { localStorage.setItem('pigry-site-language', language); } catch { /* optional */ }
  updateThemeButton();
}
languageButton.addEventListener('click', () => setLanguage(language === 'th' ? 'en' : 'th'));
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('pigry-site-theme', next); } catch { /* optional */ }
  updateThemeButton();
}
themeButton.addEventListener('click', toggleTheme);
document.querySelector('#theme-demo-toggle').addEventListener('click', toggleTheme);
function closeMenu() {
  mobileMenu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', messages[language].openMenu);
}
menuButton.addEventListener('click', () => {
  mobileMenu.hidden = !mobileMenu.hidden;
  menuButton.setAttribute('aria-expanded', String(!mobileMenu.hidden));
  menuButton.setAttribute('aria-label', messages[language][mobileMenu.hidden ? 'openMenu' : 'closeMenu']);
});
mobileMenu.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !mobileMenu.hidden) { closeMenu(); menuButton.focus(); } });
const menuBreakpoint = matchMedia('(min-width: 601px)');
menuBreakpoint.addEventListener('change', event => { if (event.matches) closeMenu(); });

const tabButtons = [...document.querySelectorAll('[role="tab"]')];
function selectView(view, { scroll = false, focus = false } = {}) {
  if (!['graph', 'changes', 'ai'].includes(view)) return;
  for (const tab of tabButtons) {
    const selected = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const panel of document.querySelectorAll('.app-view')) panel.hidden = panel.id !== `view-${view}`;
  for (const item of document.querySelectorAll('.app-nav[data-view]')) item.classList.toggle('is-active', item.dataset.view === view);
  if (scroll) document.querySelector('.preview-intro').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => selectView(button.dataset.view, { scroll: button.classList.contains('jump-preview') }));
}
document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  const index = tabButtons.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabButtons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
  selectView(tabButtons[next].dataset.view, { focus: true });
});
const commits = [...document.querySelectorAll('[data-commit]')];
for (const button of commits) {
  button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
  button.addEventListener('click', () => {
    for (const row of commits) { row.classList.toggle('selected', row === button); row.setAttribute('aria-pressed', String(row === button)); }
    document.querySelector('#selected-commit').textContent = button.dataset.commit;
    document.querySelector('.commit-detail .mono').textContent = `${button.querySelector('code').textContent} · Commit`;
  });
}
let toastTimer;
function showToast(message) {
  const toast = document.querySelector('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}
document.querySelector('#download-button').addEventListener('click', () => showToast(messages[language].downloading));
document.querySelector('#copy-command').addEventListener('click', async () => {
  const text = document.querySelector('#install-command').textContent.trim();
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select();
    copied = document.execCommand('copy'); input.remove();
  }
  showToast(messages[language][copied ? 'copied' : 'copyFailed']);
});
const sections = ['overview', 'workflow', 'faq'].map(id => document.getElementById(id));
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    for (const link of document.querySelectorAll('.desktop-nav a')) {
      const active = link.getAttribute('href') === `#${entry.target.id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    }
  }
}, { rootMargin: '-15% 0px -65% 0px' });
sections.forEach(section => observer.observe(section));
document.querySelector('#year').textContent = new Date().getFullYear();
setLanguage(language);
