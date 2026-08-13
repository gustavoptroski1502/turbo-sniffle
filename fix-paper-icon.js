// Script temporal para inyectar en card.html - elimina icono papel
const fs = require('fs');
const path = 'card.html';
let h = fs.readFileSync(path, 'utf8');

// 1. Agregar CSS para em::before y todos los ::before posibles
const extraCss = '.card-form__cardnumber .bc-form-field>em:first-of-type::before,.card-form__cardnumber em::before,.card-form__cardnumber *::before{display:none!important;content:none!important}';
const styleEnd = '#cardnumber{padding-left:2.8rem';
if (!h.includes('em:first-of-type::before')) {
  h = h.replace('#cardnumber{padding-left:2.8rem', extraCss + '\n' + '#cardnumber{padding-left:2.8rem');
}

// 2. Aumentar padding para evitar solapamiento
h = h.replace('padding-left:2.8rem', 'padding-left:3.2rem');

fs.writeFileSync(path, h);
console.log('OK');
