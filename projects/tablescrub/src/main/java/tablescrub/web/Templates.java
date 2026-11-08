package tablescrub.web;

import org.thymeleaf.TemplateEngine;
import org.thymeleaf.context.Context;
import org.thymeleaf.templatemode.TemplateMode;
import org.thymeleaf.templateresolver.ClassLoaderTemplateResolver;

import java.util.Map;
import java.util.Set;

/** Thin wrapper around Thymeleaf: full pages and named fragments (for htmx swaps). */
final class Templates {
    private final TemplateEngine engine = new TemplateEngine();

    Templates() {
        ClassLoaderTemplateResolver r = new ClassLoaderTemplateResolver();
        r.setPrefix("templates/");
        r.setSuffix(".html");
        r.setTemplateMode(TemplateMode.HTML);
        r.setCharacterEncoding("UTF-8");
        r.setCacheable(!"true".equals(System.getenv("TABLESCRUB_DEV")));
        engine.setTemplateResolver(r);
    }

    String page(String name, Map<String, Object> model) {
        return engine.process(name, new Context(java.util.Locale.ENGLISH, model));
    }

    String fragment(String name, String fragment, Map<String, Object> model) {
        return engine.process(name, Set.of(fragment), new Context(java.util.Locale.ENGLISH, model));
    }
}
