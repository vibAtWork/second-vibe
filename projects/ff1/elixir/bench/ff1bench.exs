# Cross-language FF1 benchmark protocol (see ../../bench/PROTOCOL.md).
#   MIX_ENV=prod mix run bench/ff1bench.exs ours <radix> <n> <keybits> <tweaklen>
defmodule FF1Bench do
  @alpha ~c"0123456789abcdefghijklmnopqrstuvwxyz"

  defp env(name, default) do
    case System.get_env(name) do
      nil -> default
      s -> elem(Float.parse(s), 0)
    end
  end

  defp now, do: System.monotonic_time(:nanosecond)

  defp loop(_f, x, 0), do: x
  defp loop(f, x, k), do: loop(f, f.(x), k - 1)

  defp warm(f, x, deadline, count) do
    if now() < deadline, do: warm(f, f.(x), deadline, count + 1), else: {x, count}
  end

  def measure(f, x0) do
    warm_s = env("FF1_WARMUP", 1.0)
    sample = env("FF1_SAMPLE", 0.25)
    n_samples = trunc(env("FF1_SAMPLES", 7.0))
    {x, count} = warm(f, x0, now() + trunc(warm_s * 1.0e9), 0)
    per = max(1, trunc(count * sample / warm_s))

    {res, _} =
      Enum.map_reduce(1..n_samples, x, fn _, x ->
        t0 = now()
        x = loop(f, x, per)
        {(now() - t0) / per, x}
      end)

    Enum.at(Enum.sort(res), div(n_samples, 2))
  end

  def main([impl, radix, n, keybits, tlen]) do
    "ours" = impl
    [radix, n, keybits, tlen] = Enum.map([radix, n, keybits, tlen], &String.to_integer/1)
    key = :binary.list_to_bin(Enum.to_list(0..(div(keybits, 8) - 1)))
    tweak = if tlen == 0, do: <<>>, else: :binary.list_to_bin(Enum.to_list(0..(tlen - 1)))
    pt = for i <- 0..(n - 1), do: rem(i * 7 + 3, radix)
    c = FF1.new(key, radix)
    ct = FF1.encrypt(c, tweak, pt)
    ^pt = FF1.decrypt(c, tweak, ct)
    ct_s = ct |> Enum.map(&Enum.at(@alpha, &1)) |> List.to_string()
    e = measure(&FF1.encrypt(c, tweak, &1), pt)
    d = measure(&FF1.decrypt(c, tweak, &1), ct)
    IO.puts("elixir,#{radix},#{n},#{keybits},#{tlen},encrypt,#{:erlang.float_to_binary(e, decimals: 1)},#{ct_s}")
    IO.puts("elixir,#{radix},#{n},#{keybits},#{tlen},decrypt,#{:erlang.float_to_binary(d, decimals: 1)},#{ct_s}")
  end
end

FF1Bench.main(System.argv())
