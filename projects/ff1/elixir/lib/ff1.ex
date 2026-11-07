defmodule FF1 do
  @moduledoc """
  NIST SP 800-38G FF1 format-preserving encryption with AES (Erlang `:crypto`).

  Structure follows BouncyCastle's `SP80038G.encFF1/decFF1` (P block, Q block,
  CBC-MAC PRF, S-block expansion, modular add/sub) with the same three
  optimizations used by every port in this repository:

    1. `CIPH_K(P)` is computed once per call; each round CBC-MACs only `Q`.
    2. The Feistel halves stay integers across rounds, so `NUM`/`STR` run once
       on entry and once on exit (BEAM integers are arbitrary precision).
    3. `radix^u` and `radix^v` are computed once per call.

  Numeral strings are lists of integer digits, most significant first.
  """
  import Bitwise

  defstruct [:aes, :radix]

  @type t :: %__MODULE__{aes: reference(), radix: 2..65536}

  @min_domain 1_000_000

  @doc "Creates an FF1 cipher for a 16/24/32-byte AES key and radix in 2..65536."
  @spec new(binary(), pos_integer()) :: t()
  def new(key, radix) when is_binary(key) and is_integer(radix) do
    unless radix in 2..65536, do: raise(ArgumentError, "radix must be in [2, 65536]")

    cipher =
      case byte_size(key) do
        16 -> :aes_128_ecb
        24 -> :aes_192_ecb
        32 -> :aes_256_ecb
        _ -> raise ArgumentError, "key must be 16, 24 or 32 bytes"
      end

    %__MODULE__{aes: :crypto.crypto_init(cipher, key, true), radix: radix}
  end

  @doc "Encrypts a list of digits under `tweak` (binary)."
  @spec encrypt(t(), binary(), [non_neg_integer()]) :: [non_neg_integer()]
  def encrypt(%__MODULE__{} = c, tweak, digits), do: crypt(c, tweak, digits, true)

  @doc "Decrypts a list of digits under `tweak` (binary)."
  @spec decrypt(t(), binary(), [non_neg_integer()]) :: [non_neg_integer()]
  def decrypt(%__MODULE__{} = c, tweak, digits), do: crypt(c, tweak, digits, false)

  @doc false
  def length_ok?(radix, n), do: n >= 2 and Integer.pow(radix, n) >= @min_domain

  @doc false
  # b = ceil(ceil(v*log2(radix))/8), exact (BouncyCastle calculateB_FF1).
  def calc_b(radix, v) do
    tz = trailing_zeros(radix, 0)
    odd = radix >>> tz
    bits = tz * v + if odd == 1, do: 0, else: bit_length(Integer.pow(odd, v))
    div(bits + 7, 8)
  end

  defp trailing_zeros(x, acc) when band(x, 1) == 1, do: acc
  defp trailing_zeros(x, acc), do: trailing_zeros(x >>> 1, acc + 1)

  defp bit_length(0), do: 0

  defp bit_length(x) do
    <<top, rest::binary>> = :binary.encode_unsigned(x)
    byte_size(rest) * 8 + bit_length_byte(top, 0)
  end

  defp bit_length_byte(0, acc), do: acc
  defp bit_length_byte(x, acc), do: bit_length_byte(x >>> 1, acc + 1)

  defp crypt(%__MODULE__{aes: aes, radix: radix}, tweak, x, enc?) when is_binary(tweak) do
    n = length(x)
    unless length_ok?(radix, n), do: raise(ArgumentError, "input length out of range (radix^n must be >= 1000000)")
    unless Enum.all?(x, &(is_integer(&1) and &1 >= 0 and &1 < radix)),
      do: raise(ArgumentError, "digit out of range for radix")

    t = byte_size(tweak)
    u = div(n, 2)
    v = n - u
    b = calc_b(radix, v)
    d = band(b + 7, bnot(3))
    bbits = b * 8
    dbits = d * 8
    n_blocks = div(d + 15, 16)

    p = <<1, 2, 1, radix::24, 10, band(u, 255), n::32, t::32>>
    enc_p = :crypto.crypto_update(aes, p)
    zeros = Integer.mod(-(t + b + 1), 16)
    prefix = <<tweak::binary, 0::size(zeros * 8)>>

    mod_u = Integer.pow(radix, u)
    mod_v = if v == u, do: mod_u, else: mod_u * radix

    {xa, xb} = Enum.split(x, u)
    a = Integer.undigits(xa, radix)
    bn = Integer.undigits(xb, radix)

    prf = fn i, num ->
      q = <<prefix::binary, i, num::unsigned-big-size(bbits)>>
      r = cbc_mac(aes, enc_p, q)
      <<y::unsigned-big-size(dbits), _::binary>> = expand(aes, r, n_blocks)
      y
    end

    {a, bn} =
      if enc? do
        Enum.reduce(0..9, {a, bn}, fn i, {a, bn} ->
          m = if band(i, 1) == 0, do: mod_u, else: mod_v
          {bn, rem(a + prf.(i, bn), m)}
        end)
      else
        Enum.reduce(9..0//-1, {a, bn}, fn i, {a, bn} ->
          m = if band(i, 1) == 0, do: mod_u, else: mod_v
          {Integer.mod(bn - prf.(i, a), m), a}
        end)
      end

    str(a, radix, u) ++ str(bn, radix, v)
  end

  defp cbc_mac(_aes, r, <<>>), do: r

  defp cbc_mac(aes, r, <<blk::binary-16, rest::binary>>),
    do: cbc_mac(aes, :crypto.crypto_update(aes, :crypto.exor(r, blk)), rest)

  # S = R || CIPH(R xor [1]^16) || CIPH(R xor [2]^16) || ...
  defp expand(_aes, r, 1), do: r

  defp expand(aes, r, n_blocks) do
    <<head::binary-12, w::32>> = r

    blocks =
      for j <- 1..(n_blocks - 1), into: <<>>, do: <<head::binary, bxor(w, j)::32>>

    r <> :crypto.crypto_update(aes, blocks)
  end

  defp str(x, radix, m) do
    digits = Integer.digits(x, radix)
    pad = m - length(digits)
    if pad > 0, do: List.duplicate(0, pad) ++ digits, else: digits
  end
end
