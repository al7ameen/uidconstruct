// lib/pipeline.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.

const { fetchCssFiles } = require('./css.js');
const { collectUsedClasses, extractColors, extractComponents, extractInlineStyles, extractLayout, extractResponsive, extractStyles, extractTypography, stripStyles } = require('./extract.js');
const { collectTokens, mineBreakpoints, mineComponentStyles, mineDesignTokens, mineFonts } = require('./mine.js');

async function buildAnalysisPrompt(html, $, url, domain) {
    const styles = extractStyles($);
    const inlineStyles = extractInlineStyles($);
    const typography = extractTypography($);
    const colors = extractColors($);
    const layouts = extractLayout($);
    const components = extractComponents($);
    const responsive = extractResponsive($);
    const css = await fetchCssFiles($, url);
    const usedClasses = collectUsedClasses($);
    const tokens = collectTokens(css);
    const designTokens = mineDesignTokens(css, usedClasses, tokens);
    const cssFonts = mineFonts(css);
    const cssBreakpoints = mineBreakpoints(css);
    const cleanHtml = stripStyles(html).substring(0, 2500);
    // Real per-component values, recovered from the stylesheet instead of the
    // (always-empty) computed-style calls.
    const componentRules = mineComponentStyles(css, usedClasses, tokens);

    return {
        domain,
        url,
        extracted: {
            fonts: typography.fonts,
            fontSizes: typography.sizes,
            colors: colors.slice(0, 20),
            layoutPatterns: layouts,
            componentPatterns: components,
            responsiveBreakpoints: responsive,
            designTokens: designTokens,
            cssFonts: cssFonts,
            cssBreakpoints: cssBreakpoints,
            componentRules: componentRules
        },
        rawHtml: cleanHtml,
        cssStyles: styles.substring(0, 3500)
    };
}


module.exports = { buildAnalysisPrompt };
