const menuButton = document.querySelector('.menu-button');
const navigation = document.querySelector('.navigation');

menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!open));
  navigation.classList.toggle('open', !open);
});

navigation.addEventListener('click', (event) => {
  if (event.target.matches('a') && window.matchMedia('(max-width: 850px)').matches) {
    navigation.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  }
});

const form = document.querySelector('#entry-form');
const status = document.querySelector('#form-status');
const fields = [...form.querySelectorAll('[required]')];

function validate(field) {
  let message = '';
  if (!field.value.trim()) message = `${field.labels[0].childNodes[0].textContent.trim()}を入力してください。`;
  else if (field.type === 'email' && !field.validity.valid) message = 'メールアドレスの形式を確認してください。';
  field.setAttribute('aria-invalid', String(Boolean(message)));
  field.setAttribute('aria-describedby', `${field.id}-error`);
  document.querySelector(`#${field.id}-error`).textContent = message;
  return !message;
}

fields.forEach((field) => field.addEventListener('blur', () => validate(field)));
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const results = fields.map(validate);
  const firstInvalid = fields[results.indexOf(false)];
  if (firstInvalid) {
    status.textContent = '未入力または形式に誤りがある項目を確認してください。';
    firstInvalid.focus();
    return;
  }
  status.textContent = '入力内容を確認できました。このプロトタイプから外部への送信は行われません。';
  status.focus();
});
