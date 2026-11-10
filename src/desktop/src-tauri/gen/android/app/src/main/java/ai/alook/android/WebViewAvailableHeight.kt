package ai.alook.android

object WebViewAvailableHeight {
    fun fromWindow(windowHeight: Int, parentHeight: Int, viewWindowTop: Int, viewParentTop: Int, imeBottom: Int): Int? {
        if (windowHeight <= 0 || parentHeight <= 0) return null
        val parentAvailable = (parentHeight - viewParentTop).coerceAtLeast(0)
        return (windowHeight - imeBottom.coerceAtLeast(0) - viewWindowTop).coerceIn(0, parentAvailable)
    }
}
