async function request(path, {signal} = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {headers: {Accept: 'application/json'}, signal});
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Unable to reach the store catalog. Please check your connection.');
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `Store catalog error (${res.status})`);
  return body;
}

export async function getProducts({limit = 48, offset = 0, signal} = {}) {
  const {data, meta} = await request(`/products?limit=${limit}&offset=${offset}`, {signal});
  return {products: data, total: meta.total};
}

export async function getProduct(id, {signal} = {}) {
  return (await request(`/products/${encodeURIComponent(id)}`, {signal})).data;
}

export async function getCategories({signal} = {}) {
  return (await request('/categories', {signal})).data;
}
