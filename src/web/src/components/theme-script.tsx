import Script from "next/script";

const themeScript = `(function(){try{var s=localStorage.getItem('theme');var d=s==='dark'||((!s||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);var c=document.documentElement.classList;d?c.add('dark'):c.remove('dark');document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export function ThemeScript() {
  return (
    <Script
      id="theme-script"
      strategy="beforeInteractive"
      dangerouslySetInnerHTML={{ __html: themeScript }}
    />
  );
}
