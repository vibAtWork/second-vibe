-- All hosts in one domain share a time zone (logs line up).
SELECT d.value ->> '$' AS domain, group_concat(DISTINCT t.value) AS timezones
FROM opts d JOIN opts t ON t.host = d.host AND t.path = 'time.timeZone'
WHERE d.path = 'networking.domain'
GROUP BY d.value HAVING count(DISTINCT t.value) > 1;
