package expo.modules.arxdrxd

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Immutable v1 launch content; provenance and execution/protocol IDs are not configuration. */
object ServiceDefinitions {
  private val fields = listOf("name", "script", "argv", "identity", "cwd", "environment", "endpoints")
  fun configuration(request: JSONObject): JSONObject = JSONObject().apply {
    put("name", request.getString("name")); put("identity", request.optString("identity", "app"))
    put("script", request.optString("script")); put("argv", request.optJSONArray("argv") ?: JSONObject.NULL)
    put("cwd", request.optString("cwd")); put("environment", request.optJSONObject("environment") ?: JSONObject())
    put("endpoints", request.optJSONArray("endpoints") ?: JSONArray())
  }
  fun canonical(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    else -> value.toString()
  }
  fun id(configuration: JSONObject): String {
    require(configuration.keys().asSequence().toSet() == fields.toSet()) { "Invalid service definition fields" }
    val hash = MessageDigest.getInstance("SHA-256").digest(("arxd-service-definition-v1\n" + canonical(configuration)).toByteArray(Charsets.UTF_8))
    return "svc-v1-" + hash.joinToString("") { "%02x".format(it.toInt() and 255) }
  }
  fun valid(id: String) { require(id.matches(Regex("svc-v1-[a-f0-9]{64}"))) { "Invalid service definition identity" } }
}
