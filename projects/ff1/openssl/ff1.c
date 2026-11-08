/*
 * NIST SP 800-38G FF1 on OpenSSL libcrypto.
 *
 * Structure follows BouncyCastle's SP80038G.encFF1/decFF1. Optimizations
 * (shared with the other ports in this repository):
 *   1. Per-(n, t) values (b, d, CIPH_K(P), radix^u, radix^v) are cached on the
 *      context, so repeated calls with the same length skip all setup.
 *   2. Q blocks made only of tweak/zero bytes are identical every round; their
 *      CBC-MAC is computed once per call and each round continues from it.
 *   3. Feistel halves stay numbers across rounds (NUM/STR only at entry/exit).
 *   4. Fast path when radix^v < 2^96: halves are unsigned __int128, the single
 *      varying Q block is one 128-bit XOR, S = R (d <= 16), and the modular
 *      reduction is a hardware 128/64 division. Larger domains use BIGNUM.
 *   5. Digit extraction divides by radix with a precomputed reciprocal.
 */
#include "ff1.h"

#include <stdlib.h>
#include <string.h>

#define BLOCK 16
#define MIN_DOMAIN 1000000ULL

typedef ff1_u128 u128;

static inline uint64_t bswap64(uint64_t x) { return __builtin_bswap64(x); }

static inline u128 load_be128(const uint8_t *p)
{
    uint64_t hi, lo;
    memcpy(&hi, p, 8);
    memcpy(&lo, p + 8, 8);
    return ((u128)bswap64(hi) << 64) | bswap64(lo);
}

static inline void store_be128(uint8_t *p, u128 x)
{
    uint64_t hi = bswap64((uint64_t)(x >> 64)), lo = bswap64((uint64_t)x);
    memcpy(p, &hi, 8);
    memcpy(p + 8, &lo, 8);
}

/* (hi:lo) / m with hi < m: quotient and remainder. */
static inline uint64_t divrem_128_64(uint64_t hi, uint64_t lo, uint64_t m, uint64_t *rem)
{
#if defined(__x86_64__)
    uint64_t q, r;
    __asm__("divq %4" : "=a"(q), "=d"(r) : "a"(lo), "d"(hi), "rm"(m) : "cc");
    *rem = r;
    return q;
#else
    u128 n = ((u128)hi << 64) | lo;
    *rem = (uint64_t)(n % m);
    return (uint64_t)(n / m);
#endif
}

static inline u128 rem_u128(u128 y, u128 m)
{
    if ((m >> 64) == 0) {
        uint64_t mm = (uint64_t)m, hi = (uint64_t)(y >> 64), r;
        if (hi >= mm)
            hi %= mm;
        divrem_128_64(hi, (uint64_t)y, mm, &r);
        return r;
    }
    return y % m;
}

/*
 * Remainder by an invariant modulus with a precomputed reciprocal
 * (Moller & Granlund, "Improved division by invariant integers", 2011):
 * two multiplications instead of a hardware divide.
 */
static inline uint64_t rem_2by1(uint64_t u1, uint64_t u0, uint64_t d, uint64_t v)
{
    u128 q = (u128)v * u1 + (((u128)u1 << 64) | u0);
    uint64_t q1 = (uint64_t)(q >> 64) + 1, q0 = (uint64_t)q;
    uint64_t r = u0 - q1 * d;
    if (r > q0)
        r += d;
    if (r >= d)
        r -= d;
    return r;
}

static inline u128 rem_3by2(uint64_t u2, uint64_t u1, uint64_t u0, u128 D, uint64_t v)
{
    uint64_t d1 = (uint64_t)(D >> 64), d0 = (uint64_t)D;
    u128 q = (u128)v * u2 + (((u128)u2 << 64) | u1);
    uint64_t q1 = (uint64_t)(q >> 64), q0 = (uint64_t)q;
    uint64_t r1 = u1 - q1 * d1;
    u128 r = ((((u128)r1 << 64) | u0) - (u128)d0 * q1) - D;
    if ((uint64_t)(r >> 64) >= q0)
        r += D;
    if (r >= D)
        r -= D;
    return r;
}

static void make_recip(struct ff1_recip *rc, u128 m)
{
    if ((m >> 64) == 0) {
        rc->wide = 0;
        rc->s = __builtin_clzll((uint64_t)m);
        uint64_t d = (uint64_t)m << rc->s;
        rc->d = d;
        rc->v = (uint64_t)(~(u128)0 / d); /* floor((2^128-1)/d) - 2^64, mod 2^64 */
    } else {
        rc->wide = 1;
        rc->s = __builtin_clzll((uint64_t)(m >> 64));
        u128 D = m << rc->s;
        rc->d = D;
        /* v = floor((2^192-1)/D) - 2^64 via restoring long division (once per length). */
        u128 rem = 0;
        uint64_t q = 0;
        int top = 0; /* bit 128 of the running remainder */
        for (int bit = 191; bit >= 0; bit--) {
            top = (int)(rem >> 127);
            rem = (rem << 1) | 1u; /* numerator is all ones */
            int ge = top || rem >= D;
            if (ge)
                rem -= D;
            if (bit < 64)
                q = (q << 1) | (uint64_t)ge;
        }
        rc->v = q;
    }
}

static inline u128 rem_recip(u128 y, const struct ff1_recip *rc)
{
#if defined(__x86_64__)
    /* Measured: a hardware divq beats the 2-by-1 reciprocal for 64-bit moduli. */
    if (!rc->wide)
        return rem_u128(y, rc->d >> rc->s);
#endif
    const int s = rc->s;
    uint64_t hi = (uint64_t)(y >> 64), lo = (uint64_t)y;
    uint64_t u2 = s ? hi >> (64 - s) : 0;
    uint64_t u1 = (hi << s) | (s ? lo >> (64 - s) : 0);
    uint64_t u0 = lo << s;
    if (!rc->wide) {
        uint64_t d = (uint64_t)rc->d;
        uint64_t r = rem_2by1(u2, u1, d, rc->v);
        return rem_2by1(r, u0, d, rc->v) >> s;
    }
    return rem_3by2(u2, u1, u0, rc->d, rc->v) >> s;
}

static inline int bitlen128(u128 x)
{
    uint64_t hi = (uint64_t)(x >> 64), lo = (uint64_t)x;
    if (hi)
        return 128 - __builtin_clzll(hi);
    return lo ? 64 - __builtin_clzll(lo) : 0;
}

/* w / radix for w < 2^63 via multiply by ceil(2^64/radix) plus one correction. */
static inline uint64_t div_radix(const ff1_ctx *c, uint64_t w, uint64_t *rem)
{
    uint64_t q = (uint64_t)(((u128)w * c->magic) >> 64);
    uint64_t r = w - q * c->radix;
    if (r > w) { /* q was one too large (r wrapped) */
        q--;
        r += c->radix;
    }
    *rem = r;
    return q;
}

static void free_params(ff1_params *p)
{
    BN_free(p->bmod_u);
    BN_free(p->bmod_v);
    p->bmod_u = p->bmod_v = NULL;
    p->valid = 0;
}

int ff1_init(ff1_ctx *c, const uint8_t *key, size_t key_len, unsigned radix)
{
    const EVP_CIPHER *ciph;
    memset(c, 0, sizeof(*c));
    if (radix < 2 || radix > 65536)
        return FF1_ERR_RADIX;
    switch (key_len) {
    case 16: ciph = EVP_aes_128_ecb(); break;
    case 24: ciph = EVP_aes_192_ecb(); break;
    case 32: ciph = EVP_aes_256_ecb(); break;
    default: return FF1_ERR_KEY;
    }
    c->aes = EVP_CIPHER_CTX_new();
    c->bn = BN_CTX_new();
    c->a = BN_new();
    c->b = BN_new();
    c->y = BN_new();
    if (!c->aes || !c->bn || !c->a || !c->b || !c->y ||
        EVP_EncryptInit_ex(c->aes, ciph, NULL, key, NULL) != 1 ||
        EVP_CIPHER_CTX_set_padding(c->aes, 0) != 1) {
        ff1_free(c);
        return FF1_ERR_INTERNAL;
    }
    c->radix = radix;
    c->group_len = 0;
    c->group_pow = 1;
    while (c->group_pow <= (uint64_t)INT64_MAX / radix) { /* keep groups < 2^63 */
        c->group_pow *= radix;
        c->group_len++;
    }
    c->magic = UINT64_MAX / radix + 1;
    return FF1_OK;
}

void ff1_free(ff1_ctx *c)
{
    free_params(&c->p);
    EVP_CIPHER_CTX_free(c->aes);
    BN_CTX_free(c->bn);
    BN_free(c->a);
    BN_free(c->b);
    BN_free(c->y);
    c->aes = NULL;
    c->bn = NULL;
    c->a = c->b = c->y = NULL;
}

static inline int aes_block(ff1_ctx *c, uint8_t *out, const uint8_t *in)
{
    /* EVP_Cipher is the thin one-shot entry point; ECB, no padding. */
    return EVP_Cipher(c->aes, out, in, BLOCK) > 0;
}

static int check_length(unsigned radix, size_t n)
{
    uint64_t p = 1;
    if (n < 2 || n > 0xffffffffUL)
        return 0;
    for (size_t i = 0; i < n; i++) {
        p *= radix;
        if (p >= MIN_DOMAIN)
            return 1;
    }
    return 0;
}

static int compute_params(ff1_ctx *c, size_t n, size_t t)
{
    ff1_params *p = &c->p;
    if (p->valid && p->n == n && p->t == t)
        return 1;
    free_params(p);
    p->n = n;
    p->t = t;
    p->u = n / 2;
    p->v = n - p->u;

    /* radix^v < 2^96  =>  b <= 12, d <= 16: everything fits in a u128. */
    u128 pv = 1;
    p->fast = !c->force_bignum;
    for (size_t k = 0; k < p->v && p->fast; k++) {
        pv *= c->radix;
        if (pv >> 96)
            p->fast = 0;
    }
    if (p->fast) {
        u128 pu = 1;
        for (size_t k = 0; k < p->u; k++)
            pu *= c->radix;
        p->mod_u = pu;
        p->mod_v = pv;
        p->b = (bitlen128(pv - 1) + 7) / 8;
        make_recip(&p->rec_u, pu);
        make_recip(&p->rec_v, pv);
    } else {
        BN_CTX_start(c->bn);
        BIGNUM *r = BN_CTX_get(c->bn), *e = BN_CTX_get(c->bn), *tmp = BN_CTX_get(c->bn);
        p->bmod_u = BN_new();
        p->bmod_v = BN_new();
        int ok = tmp && p->bmod_u && p->bmod_v && BN_set_word(r, c->radix) &&
                 BN_set_word(e, p->u) && BN_exp(p->bmod_u, r, e, c->bn) &&
                 (p->u == p->v ? BN_copy(p->bmod_v, p->bmod_u) != NULL
                               : BN_mul(p->bmod_v, p->bmod_u, r, c->bn)) &&
                 BN_copy(tmp, p->bmod_v) && BN_sub_word(tmp, 1);
        if (ok)
            p->b = (BN_num_bits(tmp) + 7) / 8;
        BN_CTX_end(c->bn);
        if (!ok) {
            free_params(p);
            return 0;
        }
    }
    p->d = (p->b + 7) & ~3;

    uint8_t P[BLOCK] = {1, 2, 1, (uint8_t)(c->radix >> 16), (uint8_t)(c->radix >> 8),
                        (uint8_t)c->radix, 10, (uint8_t)p->u,
                        (uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n,
                        (uint8_t)(t >> 24), (uint8_t)(t >> 16), (uint8_t)(t >> 8), (uint8_t)t};
    if (!aes_block(c, p->enc_p, P)) {
        free_params(p);
        return 0;
    }
    p->valid = 1;
    return 1;
}

/* Q byte at position k when k < round_idx (tweak, then zero padding). */
static inline uint8_t qconst(const uint8_t *T, size_t t, size_t k) { return k < t ? T[k] : 0; }

/* CBC-MAC state after P and every Q block lying entirely before round_idx. */
static int prefix_state(ff1_ctx *c, const uint8_t *T, size_t t, size_t round_idx, uint8_t X[BLOCK],
                        size_t *var_off)
{
    size_t off = 0;
    memcpy(X, c->p.enc_p, BLOCK);
    for (; off + BLOCK <= round_idx; off += BLOCK) {
        for (int j = 0; j < BLOCK; j++)
            X[j] ^= qconst(T, t, off + j);
        if (!aes_block(c, X, X))
            return 0;
    }
    *var_off = off;
    return 1;
}

/* NUM_radix over uint64 digit groups, into a u128 (fast path). */
static u128 num128(const ff1_ctx *c, const uint16_t *x, size_t len)
{
    u128 res = 0;
    for (size_t i = 0; i < len;) {
        size_t end = i + c->group_len;
        if (end > len)
            end = len;
        uint64_t acc = 0, pw = 1;
        for (; i < end; i++) {
            acc = acc * c->radix + x[i];
            pw *= c->radix;
        }
        res = res * pw + acc;
    }
    return res;
}

static inline void str_group(const ff1_ctx *c, uint64_t w, uint16_t *out, size_t *i)
{
    for (int k = 0; k < c->group_len && *i > 0; k++) {
        uint64_t r;
        w = div_radix(c, w, &r);
        out[--*i] = (uint16_t)r;
    }
}

static void str128(const ff1_ctx *c, u128 v, uint16_t *out, size_t m)
{
    size_t i = m;
    while (i > 0) {
        uint64_t w;
        if ((v >> 64) == 0 && (uint64_t)v < c->group_pow) {
            w = (uint64_t)v;
            v = 0;
        } else {
            uint64_t hi = (uint64_t)(v >> 64), qhi = hi / c->group_pow, r;
            uint64_t qlo = divrem_128_64(hi % c->group_pow, (uint64_t)v, c->group_pow, &r);
            v = ((u128)qhi << 64) | qlo;
            w = r;
        }
        str_group(c, w, out, &i);
    }
}

static int crypt_fast(ff1_ctx *c, const uint8_t *T, size_t t, const uint16_t *x,
                      uint16_t *out, int enc)
{
    const ff1_params *p = &c->p;
    size_t zeros = (size_t)(-(long long)(t + p->b + 1)) & 15;
    size_t round_idx = t + zeros, qlen = round_idx + 1 + p->b, var_off;
    uint8_t X[BLOCK], blk[BLOCK];
    if (!prefix_state(c, T, t, round_idx, X, &var_off))
        return FF1_ERR_INTERNAL;
    /* var_off == qlen - 16: the one varying block. Fold its constant bytes in. */
    for (int j = 0; j < BLOCK; j++)
        blk[j] = var_off + j < round_idx ? qconst(T, t, var_off + j) : 0;
    (void)qlen;
    const u128 xconst = load_be128(X) ^ load_be128(blk);
    const int ishift = 8 * p->b, yshift = 128 - 8 * p->d;

    u128 A = num128(c, x, p->u), B = num128(c, x + p->u, p->v);
    if (enc) {
        for (unsigned i = 0; i < 10; i++) {
            store_be128(blk, xconst ^ ((u128)i << ishift) ^ B);
            if (!aes_block(c, blk, blk))
                return FF1_ERR_INTERNAL;
            const u128 m = (i & 1) ? p->mod_v : p->mod_u;
            u128 y = rem_recip(load_be128(blk) >> yshift, (i & 1) ? &p->rec_v : &p->rec_u);
            u128 cc = A + y;
            if (cc >= m)
                cc -= m;
            A = B;
            B = cc;
        }
    } else {
        for (int i = 9; i >= 0; i--) {
            store_be128(blk, xconst ^ ((u128)i << ishift) ^ A);
            if (!aes_block(c, blk, blk))
                return FF1_ERR_INTERNAL;
            const u128 m = (i & 1) ? p->mod_v : p->mod_u;
            u128 y = rem_recip(load_be128(blk) >> yshift, (i & 1) ? &p->rec_v : &p->rec_u);
            u128 cc = B >= y ? B - y : B + (m - y);
            B = A;
            A = cc;
        }
    }
    str128(c, A, out, p->u);
    str128(c, B, out + p->u, p->v);
    return FF1_OK;
}

static int num_bn(const ff1_ctx *c, const uint16_t *x, size_t len, BIGNUM *res)
{
    BN_zero(res);
    for (size_t i = 0; i < len;) {
        size_t end = i + c->group_len;
        if (end > len)
            end = len;
        uint64_t acc = 0, pw = 1;
        for (; i < end; i++) {
            acc = acc * c->radix + x[i];
            pw *= c->radix;
        }
        if (!BN_mul_word(res, pw) || !BN_add_word(res, acc))
            return 0;
    }
    return 1;
}

/* STR^m_radix; consumes (destroys) v. */
static void str_bn(const ff1_ctx *c, BIGNUM *v, uint16_t *out, size_t m)
{
    size_t i = m;
    while (i > 0)
        str_group(c, BN_div_word(v, c->group_pow), out, &i);
}

static int crypt_bn(ff1_ctx *c, const uint8_t *T, size_t t, const uint16_t *x,
                    uint16_t *out, int enc)
{
    const ff1_params *p = &c->p;
    const int b = p->b, d = p->d;
    size_t zeros = (size_t)(-(long long)(t + b + 1)) & 15;
    size_t round_idx = t + zeros, qlen = round_idx + 1 + b, var_off;
    int n_blocks = (d + BLOCK - 1) / BLOCK;
    uint8_t X[BLOCK];
    if (!prefix_state(c, T, t, round_idx, X, &var_off))
        return FF1_ERR_INTERNAL;

    size_t vlen = qlen - var_off; /* varying tail: whole blocks */
    uint8_t vbuf[512], sbuf[512];
    uint8_t *V = vlen <= sizeof vbuf ? vbuf : malloc(vlen);
    uint8_t *S = (size_t)n_blocks * BLOCK <= sizeof sbuf ? sbuf : malloc((size_t)n_blocks * BLOCK);
    int ret = FF1_ERR_INTERNAL;
    if (!V || !S)
        goto out;
    for (size_t k = 0; k < vlen; k++)
        V[k] = var_off + k < round_idx ? qconst(T, t, var_off + k) : 0;
    const size_t ridx = round_idx - var_off, noff = ridx + 1;

    BIGNUM *A = c->a, *B = c->b, *y = c->y;
    if (!num_bn(c, x, p->u, A) || !num_bn(c, x + p->u, p->v, B))
        goto out;

    for (int k = 0; k < 10; k++) {
        int i = enc ? k : 9 - k;
        V[ridx] = (uint8_t)i;
        if (BN_bn2binpad(enc ? B : A, V + noff, b) != b)
            goto out;
        uint8_t R[BLOCK];
        memcpy(R, X, BLOCK);
        for (size_t off = 0; off < vlen; off += BLOCK) {
            for (int j = 0; j < BLOCK; j++)
                R[j] ^= V[off + j];
            if (!aes_block(c, R, R))
                goto out;
        }
        memcpy(S, R, BLOCK);
        uint32_t j0 = ((uint32_t)R[12] << 24) | ((uint32_t)R[13] << 16) |
                      ((uint32_t)R[14] << 8) | R[15];
        for (int j = 1; j < n_blocks; j++) {
            uint8_t *blk = S + j * BLOCK;
            uint32_t w = j0 ^ (uint32_t)j;
            memcpy(blk, R, 12);
            blk[12] = (uint8_t)(w >> 24);
            blk[13] = (uint8_t)(w >> 16);
            blk[14] = (uint8_t)(w >> 8);
            blk[15] = (uint8_t)w;
        }
        if (n_blocks > 1 && EVP_Cipher(c->aes, S + BLOCK, S + BLOCK, (n_blocks - 1) * BLOCK) <= 0)
            goto out;
        if (!BN_bin2bn(S, d, y))
            goto out;
        const BIGNUM *m = (i & 1) ? p->bmod_v : p->bmod_u;
        if (enc) {
            if (!BN_add(A, A, y) || !BN_nnmod(A, A, m, c->bn))
                goto out;
        } else {
            if (!BN_sub(B, B, y) || !BN_nnmod(B, B, m, c->bn))
                goto out;
        }
        BIGNUM *tmp = A; A = B; B = tmp;
    }
    str_bn(c, A, out, p->u);
    str_bn(c, B, out + p->u, p->v);
    ret = FF1_OK;
out:
    if (V && V != vbuf)
        free(V);
    if (S && S != sbuf)
        free(S);
    return ret;
}

static int crypt(ff1_ctx *c, const uint8_t *T, size_t t, const uint16_t *x,
                 uint16_t *out, size_t n, int enc)
{
    if (!(c->p.valid && c->p.n == n) && !check_length(c->radix, n))
        return FF1_ERR_LENGTH;
    for (size_t i = 0; i < n; i++)
        if (x[i] >= c->radix)
            return FF1_ERR_DIGIT;
    if (t > 0xffffffffUL || !compute_params(c, n, t))
        return FF1_ERR_INTERNAL;
    return c->p.fast ? crypt_fast(c, T, t, x, out, enc) : crypt_bn(c, T, t, x, out, enc);
}

int ff1_encrypt(ff1_ctx *c, const uint8_t *tweak, size_t tweak_len,
                const uint16_t *in, uint16_t *out, size_t n)
{
    return crypt(c, tweak, tweak_len, in, out, n, 1);
}

int ff1_decrypt(ff1_ctx *c, const uint8_t *tweak, size_t tweak_len,
                const uint16_t *in, uint16_t *out, size_t n)
{
    return crypt(c, tweak, tweak_len, in, out, n, 0);
}
