// Decorative editorial photography only. The product catalog is loaded from Odoo through /api.
export const photos = {
 hero:'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=1800&q=85',
 editorial:'https://images.unsplash.com/photo-1539109136881-3be0616acf4b?w=1100&q=85',
 story:'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1200&q=85'
};
export const placeholder = 'data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#f1ede6"/><text x="200" y="258" text-anchor="middle" font-family="Georgia,serif" font-size="30" letter-spacing="4" fill="#bdb4a6">MAISON.</text></svg>');
export const money = (n, currency='MAD') => new Intl.NumberFormat('fr-MA',{maximumFractionDigits:2}).format(n)+' '+(currency||'MAD');
